import type { AgentChunkRuntimeEvent } from "../../domain/agent/AgentRuntimeEvent"
import { agentChunkToFoldedReasoningText, agentChunkToTerminalResult, agentChunkToTranscriptText } from "./ConversationSupport"
import { isToolTranscript, normalizeTranscriptText } from "./TranscriptTextPolicy"

type Callbacks = Readonly<{
	noteActivity: (reason: string) => void
	noteQuietActivity: (reason: string) => void
	finishTask: (status: string, text: string) => void
	addMessage: (message: Record<string, unknown>) => void
	recordTool: (text: string) => void
	foldReasoning: (text: string) => void
	updateTask: () => void
	broadcast: () => void
	schedulePartial: () => void
	recentTexts: () => string[]
	commandOutputLimit: () => number
	agentTranscriptLimit: () => number
	logSkipped: (chunk: unknown) => void
}>

export class AgentChunkEventProjector {
	constructor(private readonly callbacks: Callbacks) {}

	handle(event: AgentChunkRuntimeEvent) {
		const textChunk = typeof event.chunk === "string" ? event.chunk : ""
		if (!textChunk && !Object.keys(asRecord(event.chunk)).length) return
		if (event.stream === "agent") {
			this.callbacks.noteQuietActivity("chunk:agent")
			this.agent(event.chunk)
			return
		}
		this.callbacks.noteActivity(`chunk:${event.stream || "unknown"}`)
		this.callbacks.addMessage({ type: "say", say: event.stream === "stderr" ? "command_output" : "tool", text: truncate(textChunk, this.callbacks.commandOutputLimit()), isCollapsed: true, isExpanded: false })
		this.finish()
	}

	private agent(chunk: unknown) {
		const terminal = agentChunkToTerminalResult(chunk)
		if (terminal) {
			this.callbacks.noteActivity(terminal.reason)
			this.callbacks.finishTask(terminal.status, terminal.text)
			this.finish()
			return
		}
		const text = agentChunkToTranscriptText(chunk)
		if (!text.trim()) {
			const reasoning = agentChunkToFoldedReasoningText(chunk)
			if (reasoning.trim()) {
				this.callbacks.foldReasoning(reasoning)
				this.callbacks.updateTask()
				this.callbacks.schedulePartial()
				return
			}
			this.callbacks.logSkipped(chunk)
			return
		}
		const capped = truncate(text, this.callbacks.agentTranscriptLimit())
		const normalized = normalizeTranscriptText(capped)
		if (!normalized || this.callbacks.recentTexts().some((recent) => normalizeTranscriptText(recent) === normalized)) return
		if (isToolTranscript(capped)) this.callbacks.recordTool(capped)
		else this.callbacks.addMessage({ type: "say", say: "text", text: capped })
		this.finish()
	}

	private finish() { this.callbacks.updateTask(); this.callbacks.broadcast() }
}

function truncate(value: string, maxChars: number) { return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n\n[truncated ${value.length - maxChars} chars]` }
function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
