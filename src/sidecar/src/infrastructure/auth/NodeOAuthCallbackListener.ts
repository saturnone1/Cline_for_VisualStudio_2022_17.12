import http from "node:http"
import type { OAuthCallbackHttpHandler, OAuthCallbackListenerPort } from "../../application/ports/OAuthCallbackListenerPort"

export class NodeOAuthCallbackListener implements OAuthCallbackListenerPort {
	private server: http.Server | null = null
	private port = 0

	constructor(private readonly preferredPort = 0) {}

	async start(handler: OAuthCallbackHttpHandler) {
		if (this.server) return this.port
		const server = http.createServer(async (request, response) => {
			const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`)
			if (!["/oauth/callback", "/auth/callback", "/callback"].includes(url.pathname)) {
				response.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
				response.end("Not found")
				return
			}
			const result = await handler(url.toString()).catch((error) => ({ success: false, message: error instanceof Error ? error.message : String(error) }))
			response.writeHead(result.success ? 200 : 400, { "content-type": "text/html; charset=utf-8" })
			response.end(`<!doctype html><html><body><h3>LIG VS OAuth callback</h3><p>${escapeHtml(result.message)}</p><p>You can close this browser tab.</p></body></html>`)
		})
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => { server.off("listening", onListening); reject(error) }
			const onListening = () => { server.off("error", onError); resolve() }
			server.once("error", onError)
			server.once("listening", onListening)
			server.listen(this.preferredPort, "127.0.0.1")
		})
		const address = server.address()
		this.server = server
		this.port = typeof address === "object" && address ? address.port : this.preferredPort
		return this.port
	}

	dispose() { this.server?.close(); this.server = null; this.port = 0 }
}

function escapeHtml(value: string) { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] || character) }
