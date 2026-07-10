import net from "node:net"
import type { InteractionLoggerPort } from "../../application/ports/InteractionLoggerPort"
import type { SidecarConnectionScope } from "../../application/ports/SidecarConnectionPort"
import type { JsonRpcConnection } from "./JsonRpcConnection"

type JsonRpcRequest = {
	id?: string | null
	method?: string
	params?: unknown
	result?: unknown
	error?: { message?: string }
}

export type SidecarScopeFactory = (connection: JsonRpcConnection) => SidecarConnectionScope

export class SidecarRpcServer {
	private readonly scopes = new Set<SidecarConnectionScope>()
	private readonly server: net.Server
	private exiting = false

	constructor(
		private readonly pipeName: string,
		private readonly logger: InteractionLoggerPort,
		private readonly createScope: SidecarScopeFactory,
		private readonly flushLogs: () => Promise<void>,
	) {
		this.server = net.createServer((socket) => this.accept(socket))
	}

	start() {
		this.server.on("error", (error) => {
			console.error(error instanceof Error && error.stack ? error.stack : String(error))
			void this.shutdown(1)
		})
		this.server.listen(this.pipeName, () => console.log(`VsCline sidecar listening on ${this.pipeName}`))
		process.on("SIGTERM", () => void this.shutdown(0))
		process.on("SIGINT", () => void this.shutdown(0))
		process.on("unhandledRejection", (reason) => this.handleProcessError("sessionStopUnhandledRejection", reason))
		process.on("uncaughtException", (error) => this.handleProcessError("sessionStopUncaughtException", error))
	}

	private accept(socket: net.Socket) {
		socket.setEncoding("utf8")
		const connection: JsonRpcConnection = { socket, nextId: 1, pending: new Map() }
		const scope = this.createScope(connection)
		this.scopes.add(scope)
		let buffer = ""

		socket.on("data", (chunk) => {
			buffer += chunk
			for (;;) {
				const newlineIndex = buffer.indexOf("\n")
				if (newlineIndex < 0) break
				const line = buffer.slice(0, newlineIndex).trim()
				buffer = buffer.slice(newlineIndex + 1)
				if (line) {
					this.logger.log("host->sidecar", "jsonrpc.line", line)
					this.handleMessage(connection, scope, line)
				}
			}
		})

		socket.on("close", () => {
			for (const pending of connection.pending.values()) pending.reject(new Error("Host pipe closed."))
			connection.pending.clear()
			void this.shutdown(0)
		})
	}

	private handleMessage(connection: JsonRpcConnection, scope: SidecarConnectionScope, line: string) {
		let request: JsonRpcRequest
		try {
			request = JSON.parse(line) as JsonRpcRequest
		} catch (error) {
			this.write(connection.socket, {
				id: null,
				error: { code: "invalid_json", message: error instanceof Error ? error.message : String(error) },
			})
			return
		}

		if (request.method) {
			this.logger.log("host->sidecar", request.method, { id: request.id, params: request.params })
			Promise.resolve(this.dispatch(scope, request.method, request.params))
				.then((result) => {
					this.logger.log("sidecar->host", `${request.method}.result`, { id: request.id, result })
					this.write(connection.socket, { id: request.id, result })
				})
				.catch((error) => {
					this.logger.log("sidecar->host", `${request.method}.error`, {
						id: request.id,
						message: error instanceof Error ? error.message : String(error),
						stack: error instanceof Error ? error.stack : undefined,
					})
					this.write(connection.socket, {
						id: request.id,
						error: { code: "request_failed", message: error instanceof Error ? error.message : String(error) },
					})
				})
			return
		}

		const pending = connection.pending.get(String(request.id))
		if (!pending) return
		connection.pending.delete(String(request.id))
		if (request.error) {
			this.logger.log("host->sidecar", "jsonrpc.response.error", { id: request.id, error: request.error })
			pending.reject(new Error(request.error.message || JSON.stringify(request.error)))
		} else {
			this.logger.log("host->sidecar", "jsonrpc.response.result", { id: request.id, result: request.result })
			pending.resolve(request.result)
		}
	}

	private async dispatch(scope: SidecarConnectionScope, method: string, params: unknown) {
		const runtime = scope.runtime
		switch (method) {
			case "health.ping":
				return { status: "ok", sidecar: "cline-sidecar", protocol: 1, node: process.version, clineSdk: runtime.status, received: params || null }
			case "host.roundtripTest":
				return { ...asRecord(await scope.roundtrip()), clineSdk: await runtime.ensureStarted() }
			case "sdk.status": return runtime.status
			case "sdk.start": return runtime.ensureStarted()
			case "sdk.startSession": return runtime.startSession(params)
			case "sdk.send": return runtime.send(params)
			case "sdk.stopSession": return runtime.stop(params)
			case "sdk.listHistory": return runtime.listHistory(params)
			case "sdk.getSession": return runtime.getSession(params)
			case "sdk.readMessages": return runtime.readMessages(params)
			case "sdk.deleteSession": return runtime.deleteSession(params)
			case "sdk.updateSession": return runtime.updateSession(params)
			case "sdk.getUsage": return runtime.getUsage(params)
			case "sdk.restore": return runtime.restore(params)
			case "sdk.settings.list": return runtime.listSettings(params)
			case "sdk.settings.toggle": return runtime.toggleSetting(params)
			case "sdk.dispose": await runtime.dispose(); return runtime.status
			case "upstream.status": return runtime.status
			case "upstream.start": return runtime.ensureStarted()
			case "upstream.stop": await runtime.dispose(); return runtime.status
			case "webview.message": return scope.webview.handle(params)
			default: throw new Error(`Unsupported sidecar method: ${method}`)
		}
	}

	private handleProcessError(sessionStopEvent: string, error: unknown) {
		if (errorMessage(error) === "session_stop") {
			this.logger.log("sidecar", sessionStopEvent, { message: errorMessage(error) })
			return
		}
		console.error(error instanceof Error && error.stack ? error.stack : String(error))
		void this.shutdown(1)
	}

	private async shutdown(code: number) {
		if (this.exiting) return
		this.exiting = true
		for (const scope of this.scopes) {
			try { scope.webview.dispose() } catch (error) { console.error(error) }
		}
		await Promise.all([...this.scopes].map((scope) => scope.runtime.dispose().catch((error) => console.error(error))))
		this.scopes.clear()
		await this.flushLogs().catch(() => undefined)
		this.server.close(() => process.exit(code))
		setTimeout(() => process.exit(code), 500).unref()
	}

	private write(socket: net.Socket, message: unknown) {
		socket.write(`${JSON.stringify(message)}\n`)
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error)
}
