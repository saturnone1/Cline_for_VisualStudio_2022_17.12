export interface WebviewTransportPort {
	send(method: string, params: unknown): Promise<unknown>
}
