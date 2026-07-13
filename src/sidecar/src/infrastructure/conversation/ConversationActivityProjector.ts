import type { InteractionLoggerPort } from "../../application/ports/InteractionLoggerPort"
import type { ConversationProjectionState } from "../../features/conversation/ConversationProjectionState"
import { tryParseJson } from "./ToolCommandFormatting"

type ConversationActivityDependencies = {
	projection: ConversationProjectionState
	hasCurrentTask: () => boolean
	reasoningStatusIntervalMs: () => number
	logger: InteractionLoggerPort
	now?: () => number
}

export class ConversationActivityProjector {
	constructor(private readonly dependencies: ConversationActivityDependencies) {}

	recordReasoning(text: string) {
		if (!this.dependencies.hasCurrentTask()) return
		const status = this.dependencies.projection.recordReasoning((this.dependencies.now ?? Date.now)(), this.dependencies.reasoningStatusIntervalMs())
		if (status.started) this.dependencies.logger.log("sidecar", "reasoningStarted", { textLength: text.length })
		if (status.progress) this.dependencies.logger.log("sidecar", "reasoningProgress", { ...status.progress, textLength: text.length })
	}

	clearReasoning() { this.dependencies.projection.clearReasoningStatus() }

	rememberToolSummary(tool: string, text: string) {
		const parsed = asRecord(tryParseJson(text) ?? {})
		const summary = [tool, stringValue(parsed.path), stringValue(parsed.content)].filter(Boolean).join(": ")
		this.dependencies.projection.rememberToolSummary(truncate(summary || text, 2000))
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function stringValue(value: unknown) { return typeof value === "string" ? value : "" }
function truncate(value: string, maxChars: number) {
	return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n\n[truncated ${value.length - maxChars} chars]`
}
