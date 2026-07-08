import net from "node:net"
import { VisualStudioHostProvider } from "./host/VisualStudioHostProvider"
import type { JsonRpcConnection } from "./ipc/types"
import { ClineSdkRuntime } from "./sdk/ClineSdkRuntime"
import { VisualStudioWebviewRouter } from "./webview/VisualStudioWebviewRouter"
import { flushInteractionLog, logInteraction } from "./diagnostics/InteractionLog"

type JsonRpcRequest = {
	id?: string | null
	method?: string
	params?: unknown
	result?: unknown
	error?: { message?: string }
}

function getArg(name: string): string | null {
	const index = process.argv.indexOf(name)
	if (index < 0 || index + 1 >= process.argv.length) {
		return null
	}

	return process.argv[index + 1]
}

const pipeName = getArg("--pipe")

if (!pipeName) {
	console.error("Missing required --pipe argument.")
	process.exit(2)
}

const activeRouters = new Set<VisualStudioWebviewRouter>()
const activeRuntimes = new Set<ClineSdkRuntime>()
let exiting = false

const server = net.createServer((socket) => {
	socket.setEncoding("utf8")

	const connection: JsonRpcConnection = {
		socket,
		nextId: 1,
		pending: new Map(),
	}
	const webviewRouter = new VisualStudioWebviewRouter(connection)
	const clineSdk = new ClineSdkRuntime(
		connection,
		__dirname,
		(event) => webviewRouter.handleSdkEvent(event),
		(request) => webviewRouter.requestToolApproval(request),
		(question, options) => webviewRouter.requestQuestion(question, options),
		() => webviewRouter.isScheduledAgentsEnabled(),
	)
	webviewRouter.setClineSdk(clineSdk)
	activeRouters.add(webviewRouter)
	activeRuntimes.add(clineSdk)

	let buffer = ""
	socket.on("data", (chunk) => {
		buffer += chunk

		for (;;) {
			const newlineIndex = buffer.indexOf("\n")
			if (newlineIndex < 0) {
				break
			}

			const line = buffer.slice(0, newlineIndex).trim()
			buffer = buffer.slice(newlineIndex + 1)

			if (line.length > 0) {
				logInteraction("host->sidecar", "jsonrpc.line", line)
				handleMessage(connection, clineSdk, webviewRouter, line)
			}
		}
	})

	socket.on("close", () => {
		for (const pending of connection.pending.values()) {
			pending.reject(new Error("Host pipe closed."))
		}
		connection.pending.clear()
		void flushAndExit(0)
	})
})

server.on("error", (error) => {
	console.error(error instanceof Error && error.stack ? error.stack : String(error))
	process.exit(1)
})

server.listen(pipeName, () => {
	console.log(`VsCline sidecar listening on ${pipeName}`)
})

process.on("SIGTERM", () => void flushAndExit(0))
process.on("SIGINT", () => void flushAndExit(0))
process.on("unhandledRejection", (reason) => {
	if (isSessionStopError(reason)) {
		logInteraction("sidecar", "sessionStopUnhandledRejection", { message: errorMessage(reason) })
		return
	}

	console.error(reason instanceof Error && reason.stack ? reason.stack : String(reason))
	void flushAndExit(1)
})
process.on("uncaughtException", (error) => {
	if (isSessionStopError(error)) {
		logInteraction("sidecar", "sessionStopUncaughtException", { message: errorMessage(error) })
		return
	}

	console.error(error instanceof Error && error.stack ? error.stack : String(error))
	void flushAndExit(1)
})

async function flushAndExit(code: number) {
	if (exiting) {
		return
	}
	exiting = true
	for (const router of activeRouters) {
		try {
			router.dispose()
		} catch (error) {
			console.error(error)
		}
	}

	await Promise.all(
		[...activeRuntimes].map((runtime) =>
			runtime.dispose().catch((error) => console.error(error)),
		),
	)
	activeRouters.clear()
	activeRuntimes.clear()
	await flushInteractionLog().catch(() => undefined)
	server.close(() => process.exit(code))
	setTimeout(() => process.exit(code), 500).unref()
}

function handleMessage(
	connection: JsonRpcConnection,
	clineSdk: ClineSdkRuntime,
	webviewRouter: VisualStudioWebviewRouter,
	line: string,
) {
	let request: JsonRpcRequest

	try {
		request = JSON.parse(line) as JsonRpcRequest
	} catch (error) {
		write(connection.socket, {
			id: null,
			error: {
				code: "invalid_json",
				message: error instanceof Error ? error.message : String(error),
			},
		})
		return
	}

	if (request.method) {
		logInteraction("host->sidecar", request.method, { id: request.id, params: request.params })
		Promise.resolve(dispatch(connection, clineSdk, webviewRouter, request.method, request.params))
			.then((result) => {
				logInteraction("sidecar->host", `${request.method}.result`, { id: request.id, result })
				write(connection.socket, { id: request.id, result })
			})
			.catch((error) => {
				logInteraction("sidecar->host", `${request.method}.error`, {
					id: request.id,
					message: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
				})
				write(connection.socket, {
					id: request.id,
					error: {
						code: "request_failed",
						message: error instanceof Error ? error.message : String(error),
					},
				})
			})
		return
	}

	const pending = connection.pending.get(String(request.id))
	if (!pending) {
		return
	}

	connection.pending.delete(String(request.id))
	if (request.error) {
		logInteraction("host->sidecar", "jsonrpc.response.error", { id: request.id, error: request.error })
		pending.reject(new Error(request.error.message || JSON.stringify(request.error)))
	} else {
		logInteraction("host->sidecar", "jsonrpc.response.result", { id: request.id, result: request.result })
		pending.resolve(request.result)
	}
}

async function dispatch(
	connection: JsonRpcConnection,
	clineSdk: ClineSdkRuntime,
	webviewRouter: VisualStudioWebviewRouter,
	method: string,
	params: unknown,
) {
	switch (method) {
		case "health.ping":
			return {
				status: "ok",
				sidecar: "cline-sidecar",
				protocol: 1,
				node: process.version,
				clineSdk: clineSdk.status,
				received: params || null,
			}

		case "host.roundtripTest":
			return {
				...(await VisualStudioHostProvider.create(connection).roundtrip()),
				clineSdk: await clineSdk.ensureStarted(),
			}

		case "sdk.status":
			return clineSdk.status

		case "sdk.start":
			return clineSdk.ensureStarted()

		case "sdk.startSession":
			return clineSdk.startSession(params)

		case "sdk.send":
			return clineSdk.send(params)

		case "sdk.stopSession":
			return clineSdk.stop(params)

		case "sdk.listHistory":
			return clineSdk.listHistory(params)

		case "sdk.getSession":
			return clineSdk.getSession(params)

		case "sdk.readMessages":
			return clineSdk.readMessages(params)

		case "sdk.deleteSession":
			return clineSdk.deleteSession(params)

		case "sdk.updateSession":
			return clineSdk.updateSession(params)

		case "sdk.getUsage":
			return clineSdk.getUsage(params)

		case "sdk.restore":
			return clineSdk.restore(params)

		case "sdk.settings.list":
			return clineSdk.listSettings(params)

		case "sdk.settings.toggle":
			return clineSdk.toggleSetting(params)

		case "sdk.dispose":
			await clineSdk.dispose()
			return clineSdk.status

		case "upstream.status":
			return clineSdk.status

		case "upstream.start":
			return clineSdk.ensureStarted()

		case "upstream.stop":
			await clineSdk.dispose()
			return clineSdk.status

		case "webview.message":
			return webviewRouter.handle(params)

		default:
			throw new Error(`Unsupported sidecar method: ${method}`)
	}
}

function write(socket: net.Socket, message: unknown) {
	socket.write(`${JSON.stringify(message)}\n`)
}

function isSessionStopError(error: unknown) {
	return errorMessage(error) === "session_stop"
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error)
}
