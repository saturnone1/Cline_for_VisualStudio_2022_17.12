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
		this.clearProgress()
	}

	clearProgress() {
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
	beginTurn() { this.lastToolSummaries = [] }
	rememberToolSummary(summary: string, limit = 20) { this.lastToolSummaries.push(summary); if (this.lastToolSummaries.length > limit) this.lastToolSummaries = this.lastToolSummaries.slice(-limit) }
	recentToolSummaries(limit = 5) { return this.lastToolSummaries.slice(-limit) }
	mergeToolActivities(entries: readonly ToolActivityEntry[], keyOf: (entry: ToolActivityEntry) => string) { for (const entry of entries) if (!this.activeToolActivityEntries.some((existing) => keyOf(existing) === keyOf(entry))) this.activeToolActivityEntries.push(entry); this.activeToolActivityTs = this.activeReasoningTextTs; return [...this.activeToolActivityEntries] }
	finishToolActivities() { if (!this.activeToolActivityTs && this.activeToolActivityEntries.length === 0) return []; const entries = [...this.activeToolActivityEntries]; this.activeToolActivityTs = null; this.activeToolActivityEntries = []; return entries }
	beginProgressPhase(phase: ProgressPhase) { if (!this.activeProgressPhase) { this.activeProgressPhase = phase; return false }; if (this.activeProgressPhase === phase) return false; this.clearProgress(); this.activeProgressPhase = phase; return true }
	get foldedProgressText() { return [this.activeFoldedActivityText, this.activeTerminalActivityText, this.activeFoldedReasoningText].filter(Boolean).join("\n\n") }
	finishProgressMessage() { this.activeReasoningTextTs = null; this.clearProgress() }

	reset() {
		this.clearActiveInteraction()
		this.clearReasoningStatus()
		this.lastToolSummaries = []
	}
}
