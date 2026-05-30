import type net from "node:net"
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
	logInteraction("sidecar->host", method, { id, params })

	return new Promise((resolve, reject) => {
		connection.pending.set(id, { resolve, reject })
		connection.socket.write(`${JSON.stringify({ id, method, params: params || null })}\n`)
	})
}
