import type { InteractionLoggerPort } from "../../application/ports/InteractionLoggerPort"
import type { AgentRuntimeEvent } from "../../domain/agent/AgentRuntimeEvent"
import type { AgentRuntimeEventDispatcher } from "../../features/runtime/AgentRuntimeEventDispatcher"
import { shouldLogSdkEventForInteraction, summarizeSdkEventForLog } from "./WebviewInteractionLogSupport"

export class WebviewRuntimeEventIngress {
	private replacementSourceSessionId = ""
	private replacementEvents: AgentRuntimeEvent[] = []
	private readonly maxReplacementEvents = 512

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
		const sessionId = readSessionId(event)
		if (this.replacementSourceSessionId && sessionId && sessionId !== this.replacementSourceSessionId) {
			if (this.replacementEvents.length >= this.maxReplacementEvents) {
				this.replacementEvents.shift()
				this.logger.log("sidecar", "replacementEventBufferOverflow", { maxEvents: this.maxReplacementEvents })
			}
			this.replacementEvents.push(event)
			return
		}
		this.dispatcher.handle(event)
	}

	beginReplacement(sourceSessionId: string) {
		this.replacementSourceSessionId = sourceSessionId
		this.replacementEvents = []
	}

	completeReplacement(sessionId: string) {
		const buffered = this.replacementEvents
		this.replacementSourceSessionId = ""
		this.replacementEvents = []
		let replayed = 0
		for (const event of buffered) {
			if (readSessionId(event) !== sessionId) continue
			replayed++
			this.dispatcher.handle(event)
		}
		const discarded = buffered.length - replayed
		if (discarded > 0) this.logger.log("sidecar", "replacementEventsDiscarded", { sessionId, replayed, discarded })
	}

	cancelReplacement() {
		this.replacementSourceSessionId = ""
		this.replacementEvents = []
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
