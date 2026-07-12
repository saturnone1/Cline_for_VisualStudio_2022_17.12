import type { StreamingRpcHandler } from "../../features/web/StreamingRpcHandler"
import { decodeStreamingRpcCommand } from "./StreamingRpcDecoder"
import { grpcHandled, grpcResponse } from "./WebviewGrpcSupport"

type Dependencies = Readonly<{
	handler: StreamingRpcHandler
	unsubscribeTransport: (requestId: string) => boolean
}>

export class WebviewStreamingRpcRouter {
	constructor(private readonly dependencies: Dependencies) {}

	async handle(key: string, requestId: string) {
		const command = decodeStreamingRpcCommand(key)
		if (!command) return null
		const result = await this.dependencies.handler.handle(command, requestId)
		if (result.kind === "direct") return grpcHandled(...result.messages)
		if (result.kind === "payload") return grpcHandled(grpcResponse(requestId, result.payload, true))
		if (result.kind === "empty") return grpcHandled()
		return { handled: true, owner: "sidecar", reason: result.reason, webviewMessages: [] }
	}

	unsubscribe(requestId: string) {
		return this.dependencies.unsubscribeTransport(requestId) || this.dependencies.handler.unsubscribeMcp(requestId)
	}

	clear() {
		this.dependencies.handler.clear()
	}

	mcpMessages(payload: unknown) {
		return this.dependencies.handler.mcpMessages(payload, (requestId, message) => grpcResponse(requestId, message, true))
	}
}
