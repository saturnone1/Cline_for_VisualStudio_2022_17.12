import type { AgentEvent } from "../../domain/agent/AgentRuntimeEvent"
import { shouldDropTokenizedReasoning, shouldFoldTextContentAsReasoning } from "./TranscriptNormalization"

type TextProjectionCallbacks = Readonly<{
	noteActivity: (reason: string) => void
	clearReasoning: () => void
	recordReasoning: (text: string) => void
	foldReasoning: (text: string) => void
	upsertAssistant: (accumulated: string, delta: string) => void
	completeAssistant: (text: string) => void
	activeAssistantText: () => string
}>

export class AgentTextEventProjector {
	constructor(private readonly callbacks: TextProjectionCallbacks) {}

	handle(event: AgentEvent) {
		if (event.type === "TextDelta") return this.text(event)
		if (event.type === "ReasoningDelta") return this.reasoning(event)
		return { handled: false, broadcast: true }
	}

	private text(event: Extract<AgentEvent, { type: "TextDelta" }>) {
		this.callbacks.noteActivity(`${phaseName(event.phase)}:text`)
		this.callbacks.clearReasoning()
		const text = event.accumulated || event.text
		if (event.phase === "end") {
			const completed = text || this.callbacks.activeAssistantText()
			if (completed && shouldFoldTextContentAsReasoning(completed)) { this.callbacks.foldReasoning(completed); return { handled: true, broadcast: false } }
			if (completed && shouldDropTokenizedReasoning(completed)) return { handled: true, broadcast: false }
			if (completed) this.callbacks.completeAssistant(completed)
			return { handled: true, broadcast: true }
		}
		if (text) {
			if (shouldFoldTextContentAsReasoning(text)) this.callbacks.foldReasoning(text)
			else if (!shouldDropTokenizedReasoning(text)) this.callbacks.upsertAssistant(event.accumulated, event.text)
		}
		return { handled: true, broadcast: false }
	}

	private reasoning(event: Extract<AgentEvent, { type: "ReasoningDelta" }>) {
		this.callbacks.noteActivity(`${phaseName(event.phase)}:reasoning`)
		if (event.phase === "end") { this.callbacks.clearReasoning(); return { handled: true, broadcast: true } }
		this.callbacks.recordReasoning(event.text)
		if (event.text && !shouldDropTokenizedReasoning(event.text)) this.callbacks.foldReasoning(event.text)
		return { handled: true, broadcast: false }
	}
}

function phaseName(phase: "start" | "update" | "end") { return phase === "start" ? "content_start" : phase === "end" ? "content_end" : "content_update" }
