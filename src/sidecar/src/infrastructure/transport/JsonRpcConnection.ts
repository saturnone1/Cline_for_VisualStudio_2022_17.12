import type net from "node:net"
import type { WebviewTransportPort } from "../../application/ports/WebviewTransportPort"
import { logInteraction } from "../diagnostics/InteractionLog"

export type PendingRequest = {
	resolve: (value: unknown) => void
	reject: (error: Error) => void
}

export type JsonRpcConnection = {
	socket: net.Socket
	nextId: number
	pending: Map<string, PendingRequest>
}

export function sendHostRequest(connection: JsonRpcConnection, method: string, params: unknown): Promise<unknown> {
	const id = String(connection.nextId++)
	const startedAt = Date.now()
	logInteraction("sidecar->host", method, { id, params })

	return new Promise((resolve, reject) => {
		connection.pending.set(id, {
			resolve: (value) => {
				logSlowHostRequest(method, id, startedAt)
				resolve(value)
			},
			reject: (error) => {
				logSlowHostRequest(method, id, startedAt)
				reject(error)
			},
		})
		connection.socket.write(`${JSON.stringify({ id, method, params: params || null })}\n`)
	})
}

export class JsonRpcWebviewTransport implements WebviewTransportPort {
	constructor(private readonly connection: JsonRpcConnection) {}

	send(method: string, params: unknown) {
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

function readPositiveIntEnv(name: string, fallback: number) {
	const raw = process.env[name]
	const value = raw ? Number.parseInt(raw, 10) : NaN
	return Number.isFinite(value) && value > 0 ? value : fallback
}
