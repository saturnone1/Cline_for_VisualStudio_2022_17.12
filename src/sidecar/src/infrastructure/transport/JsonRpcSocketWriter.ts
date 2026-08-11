import type net from "node:net"

export type JsonRpcWritableSocket = Pick<net.Socket, "destroyed" | "writable" | "writableEnded" | "write">

export function tryWriteJsonLine(
	socket: JsonRpcWritableSocket,
	message: unknown,
	onError: (error: unknown) => void = () => undefined,
) {
	if (socket.destroyed || socket.writableEnded || !socket.writable) return false
	try {
		socket.write(`${JSON.stringify(message)}\n`, (error?: Error | null) => {
			if (error) onError(error)
		})
		return true
	} catch (error) {
		onError(error)
		return false
	}
}
