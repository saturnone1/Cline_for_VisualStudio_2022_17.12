import type { InteractionLoggerPort } from "../../application/ports/InteractionLoggerPort"

type SendLatencyTrace = {
	requestId: string
	kind: "newTask" | "askResponse"
	sessionId: string
	startedAt: number
	sdkSendAt?: number
	firstSdkEventAt?: number
	firstAssistantAt?: number
	errorAt?: number
	textLength: number
}

export class SendLatencyMonitor {
	private readonly traces = new Map<string, SendLatencyTrace>()
	constructor(private readonly logger: InteractionLoggerPort) {}

	start(requestId: string, kind: SendLatencyTrace["kind"], sessionId: string, textLength: number) {
		if (!sessionId) return
		const trace = { requestId, kind, sessionId, startedAt: Date.now(), textLength }
		this.traces.set(sessionId, trace)
		this.trimOldestTraces()
		this.logger.log("sidecar", "sendLatency.received", { correlationId: requestId, requestId, kind, sessionId, textLength })
	}

	markSdkSend(sessionId: string) { const trace = this.traces.get(sessionId); if (!trace || trace.sdkSendAt) return; trace.sdkSendAt = Date.now(); this.logger.log("sidecar", "sendLatency.sdkSend", payload(trace)) }
	markFirstSdkEvent(sessionId: string, eventType: string) { const trace = this.traces.get(sessionId); if (!trace || trace.firstSdkEventAt) return; trace.firstSdkEventAt = Date.now(); this.logger.log("sidecar", "sendLatency.firstSdkEvent", { ...payload(trace), eventType }) }
	markFirstAssistant(sessionId: string, textLength: number) { const trace = this.traces.get(sessionId); if (!trace || trace.firstAssistantAt) return; trace.firstAssistantAt = Date.now(); this.logger.log("sidecar", "sendLatency.firstAssistant", { ...payload(trace), assistantTextLength: textLength }) }
	markError(sessionId: string, error: unknown) { const trace = this.traces.get(sessionId); if (!trace || trace.errorAt) return; trace.errorAt = Date.now(); this.logger.log("sidecar", "sendLatency.error", { ...payload(trace), error: error instanceof Error ? error.message : String(error) }) }
	rebind(previousSessionId: string, nextSessionId: string) { const trace = this.traces.get(previousSessionId); if (!trace || !nextSessionId || previousSessionId === nextSessionId) return; this.traces.delete(previousSessionId); trace.sessionId = nextSessionId; this.traces.set(nextSessionId, trace) }
	correlationId(sessionId: string) { return this.traces.get(sessionId)?.requestId || "" }

	private trimOldestTraces() {
		while (this.traces.size > 100) {
			const oldest = this.traces.keys().next().value
			if (typeof oldest !== "string") return
			this.traces.delete(oldest)
		}
	}
}

function payload(trace: SendLatencyTrace) {
	const now = Date.now()
	return { correlationId: trace.requestId, requestId: trace.requestId, kind: trace.kind, sessionId: trace.sessionId, textLength: trace.textLength, toSdkSendMs: trace.sdkSendAt ? trace.sdkSendAt - trace.startedAt : undefined, toFirstSdkEventMs: trace.firstSdkEventAt ? trace.firstSdkEventAt - trace.startedAt : undefined, toFirstAssistantMs: trace.firstAssistantAt ? trace.firstAssistantAt - trace.startedAt : undefined, toErrorMs: trace.errorAt ? trace.errorAt - trace.startedAt : undefined, elapsedMs: now - trace.startedAt }
}
