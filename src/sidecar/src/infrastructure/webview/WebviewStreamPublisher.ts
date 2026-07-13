import type { InteractionLoggerPort } from "../../application/ports/InteractionLoggerPort"
import type { WebviewTransportPort } from "../../application/ports/WebviewTransportPort"
import { HOST_SIDECAR_WEBVIEW_PROTOCOL_VERSION } from "../../application/dto/WebviewRpc"
import { toProtoClineMessage } from "../conversation/ConversationMessageProjection"
import { partialMessageDeliveryKey } from "../conversation/SdkMessageTranscriptProjection"

export class WebviewStreamPublisher {
	private readonly stateRequests = new Set<string>()
	private readonly partialRequests = new Set<string>()
	private readonly stateDeliveryKeys = new Map<string, string>()
	private readonly partialDeliveryKeys = new Map<string, string>()
	private broadcastInFlight: Promise<void> | null = null
	private broadcastQueued = false

	constructor(
		private readonly transport: WebviewTransportPort,
		private readonly logger: InteractionLoggerPort,
		private readonly stateJson: () => string,
		private correlationId: () => string = () => "",
	) {}

	setCorrelationIdProvider(provider: () => string) { this.correlationId = provider }

	get hasStateSubscribers() { return this.stateRequests.size > 0 }
	subscribeState(requestId: string) { this.stateRequests.add(requestId); return grpcResponse(requestId, { stateJson: this.stateJson() }, true, this.correlationId()) }
	subscribePartial(requestId: string) { this.partialRequests.add(requestId) }

	unsubscribe(requestId: string) {
		const removed = this.stateRequests.delete(requestId) || this.partialRequests.delete(requestId)
		this.stateDeliveryKeys.delete(requestId)
		this.partialDeliveryKeys.delete(requestId)
		return removed
	}

	dispose() { this.stateRequests.clear(); this.partialRequests.clear(); this.stateDeliveryKeys.clear(); this.partialDeliveryKeys.clear() }

	buildStateMessages() {
		const stateJson = this.stateJson(), correlationId = this.correlationId(), stateKey = `${stateJson.length}:${fastStringHash(stateJson)}:${correlationId}`
		return [...this.stateRequests].flatMap((requestId) => {
			const deliveryKey = `${requestId}:${stateKey}`
			if (this.stateDeliveryKeys.get(requestId) === deliveryKey) return []
			this.stateDeliveryKeys.set(requestId, deliveryKey)
			return [grpcResponse(requestId, { stateJson }, true, correlationId)]
		})
	}

	async broadcastState() {
		if (this.broadcastInFlight) { this.broadcastQueued = true; return this.broadcastInFlight }
		this.broadcastInFlight = this.broadcastStateCore()
		try { await this.broadcastInFlight } finally { this.broadcastInFlight = null; if (this.broadcastQueued) { this.broadcastQueued = false; await this.broadcastState() } }
	}

	sendPartial(message?: Record<string, unknown>) {
		if (!message || this.partialRequests.size === 0) return
		const correlationId = this.correlationId(), messageKey = `${partialMessageDeliveryKey(message)}:${correlationId}`
		for (const requestId of this.partialRequests) {
			const deliveryKey = `${requestId}:${messageKey}`
			if (this.partialDeliveryKeys.get(requestId) === deliveryKey) continue
			this.partialDeliveryKeys.set(requestId, deliveryKey)
			this.logger.log("sidecar->webview", "partialMessage", { correlationId: correlationId || requestId, requestId, message: summarizeMessage(message) })
			this.transport.send("webview.postMessage", { message: grpcResponse(requestId, toProtoClineMessage(message), true, correlationId) }).catch((error) => { this.partialDeliveryKeys.delete(requestId); console.error(error) })
		}
	}

	private async broadcastStateCore() {
		const messages = this.buildStateMessages()
		if (!messages.length) return
		this.logger.log("sidecar->webview", "state.broadcast", { count: messages.length })
		await Promise.all(messages.map((message) => this.transport.send("webview.postMessage", { message })))
	}
}

function grpcResponse(requestId: string, message: unknown, isStreaming: boolean, correlationId = "") {
	return {
		protocol_version: HOST_SIDECAR_WEBVIEW_PROTOCOL_VERSION,
		type: "grpc_response",
		grpc_response: { request_id: requestId, ...(correlationId ? { correlation_id: correlationId } : {}), message, is_streaming: isStreaming },
	}
}
function fastStringHash(value: string) { let hash = 2166136261; for (let index = 0; index < value.length; index++) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16777619) }; return (hash >>> 0).toString(16) }
function summarizeMessage(message: Record<string, unknown>) { const text = typeof message.text === "string" ? message.text : ""; return { ts: message.ts, type: message.type, say: message.say, ask: message.ask, partial: message.partial === true, textLength: text.length, textPreview: text.slice(0, 240) } }
