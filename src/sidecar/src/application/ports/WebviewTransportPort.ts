export interface WebviewTransportPort {
	send(method: "webview.postMessage", params: unknown): Promise<unknown>
}
