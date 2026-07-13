import type { InteractionLoggerPort } from "../../application/ports/InteractionLoggerPort"
import type { AgentRuntimeEvent } from "../../domain/agent/AgentRuntimeEvent"
import type { AgentRuntimeEventDispatcher } from "../../features/runtime/AgentRuntimeEventDispatcher"
import { shouldLogSdkEventForInteraction, summarizeSdkEventForLog } from "./WebviewInteractionLogSupport"

export class WebviewRuntimeEventIngress {
	constructor(
		private readonly logger: InteractionLoggerPort,
		private readonly dispatcher: AgentRuntimeEventDispatcher,
		private readonly correlationId: (sessionId: string) => string = () => "",
	) {}

	handle(event: AgentRuntimeEvent) {
		if (shouldLogSdkEventForInteraction(event)) {
			const summary = asRecord(summarizeSdkEventForLog(event))
			const correlationId = this.correlationId(readSessionId(event))
			this.logger.log("sdk->sidecar", "sdk.event", correlationId ? { ...summary, correlationId, requestId: correlationId } : summary)
		}
		this.dispatcher.handle(event)
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : { value }
}

function readSessionId(event: AgentRuntimeEvent) {
	if ("sessionId" in event && typeof event.sessionId === "string") return event.sessionId
	const sessionId = event.payload.sessionId
	return typeof sessionId === "string" ? sessionId : ""
}
