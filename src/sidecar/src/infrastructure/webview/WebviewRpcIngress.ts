import { validateGrpcRequestContract, type GrpcRequest, type WebviewEnvelope } from "../../application/dto/WebviewRpc"
import type { InteractionLoggerPort } from "../../application/ports/InteractionLoggerPort"
import { grpcError, grpcHandled } from "./WebviewGrpcSupport"
import type { WebviewStreamingRpcRouter } from "./WebviewStreamingRpcRouter"
import type { WebviewUnaryRpcRouter } from "./WebviewUnaryRpcRouter"

type RpcIngressDependencies = {
	logger: InteractionLoggerPort
	streaming: WebviewStreamingRpcRouter
	unary: WebviewUnaryRpcRouter
	onUnaryError: (error: unknown) => Promise<void>
	slowRequestThresholdMs: () => number
}

export class WebviewRpcIngress {
	constructor(private readonly dependencies: RpcIngressDependencies) {}

	async handle(envelope: WebviewEnvelope) {
		this.dependencies.logger.log("webview->sidecar", envelope.type === "unhandled" ? envelope.originalType || "webview.message" : envelope.type, envelope)

		if (envelope.type === "grpc_request") return this.handleRequest(envelope.request)
		if (envelope.type === "grpc_request_cancel") {
			const requestId = envelope.requestId
			const disposed = this.dependencies.streaming.unsubscribe(requestId)
			this.dependencies.logger.log("webview->sidecar", disposed ? "grpc_request_cancel.streamDisposed" : "grpc_request_cancel.ignored", { requestId })
			return { handled: true, owner: "sidecar" as const, webviewMessages: [] }
		}

		return {
			handled: false,
			type: envelope.originalType,
			webviewMessages: [],
		}
	}

	private async handleRequest(request: GrpcRequest) {
		this.dependencies.logger.log("webview->sidecar", `${request.service}.${request.method}`, request)
		const startedAt = Date.now()
		const key = `${request.service}.${request.method}`
		const contract = validateGrpcRequestContract(request)
		if (!contract.ok) {
			this.dependencies.logger.log("webview->sidecar", "webviewRpcContractRejected", { key, reason: contract.reason, isStreaming: request.isStreaming })
			return grpcHandled(grpcError(request.requestId, `${contract.reason}: ${key}`, request.isStreaming))
		}

		if (request.isStreaming) {
			const result = await this.dependencies.streaming.handle(key, request.requestId)
			this.logSlowRequest(key, startedAt, true)
			return result
		}

		try {
			const result = await this.dependencies.unary.handle(key, request.requestId, request.message)
			this.logSlowRequest(key, startedAt, false)
			return result
		} catch (error) {
			this.logSlowRequest(key, startedAt, false)
			await this.dependencies.onUnaryError(error)
			return grpcHandled(grpcError(request.requestId, error instanceof Error ? error.message : String(error), false))
		}
	}

	private logSlowRequest(key: string, startedAt: number, streaming: boolean) {
		const durationMs = Date.now() - startedAt
		const thresholdMs = this.dependencies.slowRequestThresholdMs()
		if (durationMs >= thresholdMs) {
			this.dependencies.logger.log("sidecar", "webviewRpcSlow", { key, streaming, durationMs, thresholdMs })
		}
	}
}
