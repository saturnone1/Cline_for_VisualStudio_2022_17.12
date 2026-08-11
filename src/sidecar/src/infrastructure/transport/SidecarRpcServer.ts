import net from "node:net"
import type { InteractionLoggerPort } from "../../application/ports/InteractionLoggerPort"
import type { SidecarConnectionScope } from "../../application/ports/SidecarConnectionPort"
import type { JsonRpcConnection } from "./JsonRpcConnection"
import { readBoundedPositiveIntEnv, RUNTIME_DEFAULTS } from "../configuration/RuntimeEnvironment"
import { tryWriteJsonLine } from "./JsonRpcSocketWriter"
import { BoundedAsyncRequestQueue, JsonLineFrameDecoder } from "./JsonRpcIngressLimits"

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
	private readonly sockets = new Set<net.Socket>()
	private readonly server: net.Server
	private exiting = false
	private requestedShutdownGraceMs: number | undefined

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
		this.sockets.add(socket)
		socket.setEncoding("utf8")
		socket.on("error", (error) => {
			this.logger.log("sidecar", "hostPipeError", { message: errorMessage(error) })
		})
		const connection: JsonRpcConnection = { socket, nextId: 1, pending: new Map() }
		const scope = this.createScope(connection)
		this.scopes.add(scope)
		const frames = new JsonLineFrameDecoder(readRpcMaximumFrameBytes())
		const requests = new BoundedAsyncRequestQueue(readRpcMaximumConcurrentRequests(), readRpcMaximumQueuedRequests())

		socket.on("data", (chunk) => {
			const decoded = frames.push(String(chunk))
			if (decoded.overflow) {
				this.logger.log("sidecar", "hostPipeFrameRejected", { maximumBytes: readRpcMaximumFrameBytes() })
				this.write(socket, { id: null, error: { code: "frame_too_large", message: "JSON-RPC message exceeds the configured size limit." } })
				socket.end()
				return
			}
			for (const line of decoded.lines) {
				this.logger.log("host->sidecar", "jsonrpc.line", line)
				this.handleMessage(connection, scope, requests, line)
			}
		})

		socket.on("close", () => {
			requests.dispose()
			this.sockets.delete(socket)
			for (const pending of connection.pending.values()) pending.reject(new Error("Host pipe closed."))
			connection.pending.clear()
			void this.shutdown(0)
		})
	}

	private handleMessage(connection: JsonRpcConnection, scope: SidecarConnectionScope, requests: BoundedAsyncRequestQueue, line: string) {
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
			const accepted = requests.schedule(() => Promise.resolve(this.dispatch(scope, request.method!, request.params))
				.then((result) => {
					this.logger.log("sidecar->host", `${request.method}.result`, { id: request.id, result })
					this.write(connection.socket, { id: request.id, result })
					if (request.method === "upstream.stop") setImmediate(() => void this.shutdown(0))
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
				}))
			if (!accepted) this.write(connection.socket, { id: request.id, error: { code: "server_busy", message: "The sidecar request queue is full." } })
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
				return { status: "ok", sidecar: "cline-sidecar", protocol: 1, node: process.version, clineSdk: runtime.status, received: params ?? null }
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
			case "upstream.stop": {
				this.requestedShutdownGraceMs = shutdownGraceFromRequest(params)
				return runtime.status
			}
			case "webview.message": return scope.webview.handle(params)
			default: throw new Error(`Unsupported sidecar method: ${method}`)
		}
	}

	private handleProcessError(sessionStopEvent: string, error: unknown) {
		if (isExpectedRuntimeCancellation(error)) {
			this.logger.log("sidecar", sessionStopEvent, { message: errorMessage(error), expectedCancellation: true })
			return
		}
		console.error(error instanceof Error && error.stack ? error.stack : String(error))
		void this.shutdown(1)
	}

	private async shutdown(code: number) {
		if (this.exiting) return
		this.exiting = true
		const graceMs = this.requestedShutdownGraceMs ?? readShutdownGraceMs()
		setTimeout(() => {
			for (const socket of this.sockets) socket.destroy()
			process.exit(code)
		}, graceMs).unref()
		await Promise.all([...this.scopes].map((scope) => scope.webview.dispose().catch((error) => console.error(error))))
		await Promise.all([...this.scopes].map((scope) => scope.runtime.dispose().catch((error) => console.error(error))))
		this.scopes.clear()
		await this.flushLogs().catch(() => undefined)
		this.server.close(() => process.exit(code))
		for (const socket of this.sockets) socket.end()
	}

	private write(socket: net.Socket, message: unknown) {
		tryWriteJsonLine(socket, message, (error) => {
			this.logger.log("sidecar", "hostPipeWriteFailed", { message: errorMessage(error) })
		})
	}
}

export function isExpectedRuntimeCancellation(error: unknown) {
	const name = error instanceof Error ? error.name : ""
	const message = errorMessage(error).trim().toLowerCase()
	return message === "session_stop"
		|| name === "AgentRuntimeAbortError"
		|| (name === "AbortError" && (message === "run aborted" || message === "the operation was aborted"))
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error)
}

function readShutdownGraceMs() {
	return readBoundedPositiveIntEnv("VSCLINE_SIDECAR_SHUTDOWN_GRACE_MS", RUNTIME_DEFAULTS.shutdownGraceMs, 1_000, 15_000)
}

function readRpcMaximumFrameBytes() {
	return readBoundedPositiveIntEnv("VSCLINE_RPC_MAX_FRAME_BYTES", RUNTIME_DEFAULTS.rpcMaximumFrameBytes, 1024 * 1024, 128 * 1024 * 1024)
}

function readRpcMaximumConcurrentRequests() {
	return readBoundedPositiveIntEnv("VSCLINE_RPC_MAX_CONCURRENT_REQUESTS", RUNTIME_DEFAULTS.rpcMaximumConcurrentRequests, 1, 128)
}

function readRpcMaximumQueuedRequests() {
	return readBoundedPositiveIntEnv("VSCLINE_RPC_MAX_QUEUED_REQUESTS", RUNTIME_DEFAULTS.rpcMaximumQueuedRequests, 1, 2048)
}

function shutdownGraceFromRequest(value: unknown) {
	const graceMs = Number(asRecord(value).graceMs)
	return Number.isFinite(graceMs) ? Math.min(15_000, Math.max(1_000, Math.floor(graceMs))) : undefined
}
