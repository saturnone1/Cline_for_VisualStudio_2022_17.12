export type ToolActivityEntry = {
	kind: "file" | "search" | "edit" | "command" | "tool"
	label: string
	detail?: string
}

export type ProgressPhase = "activity" | "terminal" | "reasoning"

export class ConversationProjectionState {
	activePartialTextTs: number | null = null
	activeAssistantTextBuffer = ""
	activeReasoningTextTs: number | null = null
	activeFoldedReasoningText = ""
	activeFoldedActivityText = ""
	activeTerminalActivityText = ""
	activeProgressPhase: ProgressPhase | null = null
	activeToolActivityTs: number | null = null
	activeToolActivityEntries: ToolActivityEntry[] = []
	reasoningStartedAt = 0
	reasoningChunkCount = 0
	lastReasoningStatusAt = 0
	lastToolSummaries: string[] = []

	get hasActiveInteraction() {
		return Boolean(this.activePartialTextTs || this.activeReasoningTextTs || this.activeToolActivityTs || this.activeToolActivityEntries.length || this.activeAssistantTextBuffer || this.activeFoldedReasoningText || this.activeFoldedActivityText || this.activeTerminalActivityText)
	}

	clearActiveInteraction() {
		this.activePartialTextTs = null
		this.activeAssistantTextBuffer = ""
		this.activeReasoningTextTs = null
		this.activeFoldedReasoningText = ""
		this.activeFoldedActivityText = ""
		this.activeTerminalActivityText = ""
		this.activeProgressPhase = null
		this.activeToolActivityTs = null
		this.activeToolActivityEntries = []
	}

	beginTask() { this.reset() }

	recordReasoning(now: number, intervalMs: number) {
		const started = this.reasoningStartedAt === 0
		if (started) this.reasoningStartedAt = now
		this.reasoningChunkCount++
		if (now - this.lastReasoningStatusAt < intervalMs) return { started, progress: undefined }
		this.lastReasoningStatusAt = now
		return { started, progress: { elapsedSeconds: Math.max(1, Math.round((now - this.reasoningStartedAt) / 1000)), chunks: this.reasoningChunkCount } }
	}

	clearReasoningStatus() { this.reasoningStartedAt = 0; this.reasoningChunkCount = 0; this.lastReasoningStatusAt = 0 }
	rememberToolSummary(summary: string, limit = 20) { this.lastToolSummaries.push(summary); if (this.lastToolSummaries.length > limit) this.lastToolSummaries = this.lastToolSummaries.slice(-limit) }
	recentToolSummaries(limit = 5) { return this.lastToolSummaries.slice(-limit) }

	reset() {
		this.clearActiveInteraction()
		this.clearReasoningStatus()
		this.lastToolSummaries = []
	}
}
