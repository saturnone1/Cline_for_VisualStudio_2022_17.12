import type net from "node:net"
import { HOST_RPC_PROTOCOL_VERSION, type HostRpcMethodName } from "../../application/dto/generated/HostRpcContract"
import type { WebviewTransportPort } from "../../application/ports/WebviewTransportPort"
import { logInteraction } from "../diagnostics/InteractionLog"
import { readPositiveIntEnv } from "../configuration/RuntimeEnvironment"
import { tryWriteJsonLine } from "./JsonRpcSocketWriter"

export type PendingRequest = {
	resolve: (value: unknown) => void
	reject: (error: Error) => void
}

export type JsonRpcConnection = {
	socket: net.Socket
	nextId: number
	pending: Map<string, PendingRequest>
}

export function sendHostRequest(connection: JsonRpcConnection, method: HostRpcMethodName, params: unknown): Promise<unknown> {
	const id = String(connection.nextId++)
	const startedAt = Date.now()
	logInteraction("sidecar->host", method, { id, params })

	return new Promise((resolve, reject) => {
		const pending: PendingRequest = {
			resolve: (value) => {
				logSlowHostRequest(method, id, startedAt)
				resolve(value)
			},
			reject: (error) => {
				logSlowHostRequest(method, id, startedAt)
				reject(error)
			},
		}
		connection.pending.set(id, pending)
		const failWrite = (error: unknown) => {
			if (connection.pending.get(id) !== pending) return
			connection.pending.delete(id)
			pending.reject(error instanceof Error ? error : new Error(String(error)))
		}
		if (!tryWriteJsonLine(connection.socket, { protocolVersion: HOST_RPC_PROTOCOL_VERSION, id, method, params: params || null }, failWrite)) {
			failWrite(new Error("Host pipe is closed."))
		}
	})
}

export class JsonRpcWebviewTransport implements WebviewTransportPort {
	constructor(private readonly connection: JsonRpcConnection) {}

	send(method: "webview.postMessage", params: unknown) {
		return sendHostRequest(this.connection, method, params)
	}
}

function logSlowHostRequest(method: string, id: string, startedAt: number) {
	const durationMs = Date.now() - startedAt
	const thresholdMs = readPositiveIntEnv("VSCLINE_SLOW_HOST_REQUEST_MS", 750)
	if (durationMs >= thresholdMs) {
		logInteraction("sidecar", "hostRequestSlow", { id, method, durationMs, thresholdMs })
	}
}
