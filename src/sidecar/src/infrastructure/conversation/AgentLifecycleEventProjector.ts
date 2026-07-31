import type { AgentEvent } from "../../domain/agent/AgentRuntimeEvent"
import { contentToText } from "./SdkContentConversion"
import { extractCompletionTextFromResult } from "./CompletionExtraction"
import { normalizeUsageSnapshot } from "./UsageNormalization"

type Usage = Readonly<{ tokensIn?: number; tokensOut?: number; cacheReads?: number; cacheWrites?: number; totalCost?: number }>
export type CompactionNotice = Readonly<{
	phase: "started" | "completed" | "skipped" | "idle"
	sessionId: string
	reason: string
	tokensBefore?: number
	tokensAfter?: number
	messagesBefore?: number
	messagesAfter?: number
	maxInputTokens?: number
	triggerTokens?: number
	targetTokens?: number
	messageTargetTokens?: number
}>
type Callbacks = Readonly<{
	noteActivity: (reason: string) => void
	clearReasoning: () => void
	finishToolActivity: () => void
	finishProgress: () => void
	finalizePartial: () => void
	addText: (text: string) => void
	addError: (text: string) => void
	finishTask: (sessionId: string, status: string, text?: string) => void
	updateUsage: (usage: Usage) => void
	recordContextUsage: (usage: Usage) => void
	hasCompletion: () => boolean
	activePartialText: () => string
	hasAssistantAfterUser: () => boolean
	log: (event: string, details: Record<string, unknown>) => void
	formatError: (error: unknown) => string
	markErrorLatency: (sessionId: string, error: string) => void
	quarantineSession: (sessionId: string) => void
	setCompactionStatus?: (notice: CompactionNotice) => void
}>

export class AgentLifecycleEventProjector {
	constructor(private readonly callbacks: Callbacks) {}
	handle(event: AgentEvent) {
		switch (event.type) {
			case "AgentStarted": this.callbacks.noteActivity("iteration_start"); break
			case "IterationCompleted": this.iterationCompleted(event); break
			case "NoticeReceived": this.notice(event); break
			case "AssistantMessageReceived": this.assistant(event); break
			case "RunFinished": this.runFinished(event); break
			case "RunFailed": this.failed(event); break
			case "UsageUpdated": this.usage(event); break
			case "AgentDone": this.done(event); break
			case "AgentError": this.error(event); break
			default: return { handled: false, broadcast: true }
		}
		return { handled: true, broadcast: true }
	}

	private iterationCompleted(event: Extract<AgentEvent, { type: "IterationCompleted" }>) {
		this.callbacks.noteActivity("iteration_end")
		const partial = this.callbacks.activePartialText()
		if (!event.hadToolCalls && !this.callbacks.hasCompletion() && (partial.trim() || this.callbacks.hasAssistantAfterUser())) {
			this.callbacks.log("iterationEndCompletesTurn", { sessionId: event.sessionId, iteration: event.iteration, toolCallCount: event.toolCallCount, activePartialTextLength: partial.length })
			this.callbacks.finishTask(event.sessionId, "completed", partial)
		}
	}

	private notice(event: Extract<AgentEvent, { type: "NoticeReceived" }>) {
		this.callbacks.noteActivity("notice")
		const compaction = compactionNotice(event)
		if (compaction) {
			this.callbacks.setCompactionStatus?.(compaction)
			this.callbacks.log("sdkCompactionNotice", compaction)
			return
		}
		if (!event.message) return
		const text = event.reason ? `${event.message}\n\nReason: ${event.reason}` : event.message
		if (event.noticeType === "status") this.callbacks.log("sdkStatusNotice", { text }); else this.callbacks.addText(text)
	}

	private assistant(event: Extract<AgentEvent, { type: "AssistantMessageReceived" }>) {
		this.callbacks.noteActivity("assistant-message"); this.callbacks.clearReasoning()
		this.callbacks.setCompactionStatus?.({ phase: "idle", sessionId: event.sessionId, reason: "assistant-message" })
		const text = contentToText(event.message.content)
		if (text.trim()) { this.callbacks.finalizePartial(); this.callbacks.addText(text) }
	}

	private runFinished(event: Extract<AgentEvent, { type: "RunFinished" }>) {
		this.callbacks.noteActivity("run-finished"); this.finishRunProgress()
		this.applyUsage(event.result.usage || event.result.aggregateUsage || event.usage)
		this.callbacks.finishTask(event.sessionId, readString(event.result.status) || "completed", extractCompletionTextFromResult(event.result, event.completion))
	}

	private failed(event: Extract<AgentEvent, { type: "RunFailed" }>) {
		this.callbacks.noteActivity("run-failed")
		this.finishRunProgress()
		const reason = event.reason.trim()
		if (reason && reason.toLowerCase() !== "failed") {
			const text = this.callbacks.formatError(reason)
			this.callbacks.markErrorLatency(event.sessionId, text)
			this.callbacks.addError(text)
		}
		this.callbacks.quarantineSession(event.sessionId)
		this.callbacks.finishTask(event.sessionId, "failed")
	}
	private done(event: Extract<AgentEvent, { type: "AgentDone" }>) { this.callbacks.noteActivity("done"); this.finishRunProgress(); this.callbacks.finishTask(event.sessionId, statusForFinishReason(event.reason), extractCompletionTextFromResult(event.result, event.completion)) }
	private usage(event: Extract<AgentEvent, { type: "UsageUpdated" }>) {
		this.callbacks.noteActivity("usage")
		this.applyUsage({ ...event.usage, totalInputTokens: event.totalInputTokens, totalOutputTokens: event.totalOutputTokens, totalCacheReadTokens: event.totalCacheReadTokens, totalCacheWriteTokens: event.totalCacheWriteTokens, totalCost: event.totalCost ?? event.usage.totalCost ?? event.usage.cost })
		const usage = normalizeUsageSnapshot(event.usage)
		if (usage.reliable) {
			this.callbacks.recordContextUsage({ tokensIn: usage.inputTokens, tokensOut: usage.outputTokens, cacheReads: usage.cacheReadTokens, cacheWrites: usage.cacheWriteTokens, totalCost: usage.totalCost })
		}
	}
	private error(event: Extract<AgentEvent, { type: "AgentError" }>) {
		this.callbacks.noteActivity(event.recoverable ? "recoverable-error" : "error")
		const text = this.callbacks.formatError(event.error)
		if (event.recoverable) {
			this.callbacks.log("recoverableAgentError", { sessionId: event.sessionId, iteration: event.iteration, error: text })
			return
		}
		this.callbacks.addError(text)
		this.finishRunProgress()
		this.callbacks.markErrorLatency(event.sessionId, text)
		this.callbacks.quarantineSession(event.sessionId)
		this.callbacks.finishTask(event.sessionId, "failed")
	}
	private finishRunProgress() { this.callbacks.setCompactionStatus?.({ phase: "idle", sessionId: "", reason: "run-finished" }); this.callbacks.finishToolActivity(); this.finishTextProgress() }
	private finishTextProgress() { this.callbacks.finishProgress(); this.callbacks.clearReasoning() }
	private applyUsage(value: unknown) { const usage = normalizeUsageSnapshot(asRecord(value)); if (usage.reliable) this.callbacks.updateUsage({ tokensIn: usage.inputTokens, tokensOut: usage.outputTokens, cacheReads: usage.cacheReadTokens, cacheWrites: usage.cacheWriteTokens, totalCost: usage.totalCost }) }
}

function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function readString(value: unknown) { return typeof value === "string" ? value : "" }
function compactionNotice(event: Extract<AgentEvent, { type: "NoticeReceived" }>): CompactionNotice | undefined {
	const metadata = asRecord(event.raw.metadata)
	const reason = event.reason || readString(event.raw.reason) || readString(event.raw.kind) || readString(metadata.reason) || readString(metadata.kind)
	if (reason !== "auto_compaction" && reason !== "manual_compaction") return undefined
	const phase = readString(event.raw.phase) || readString(metadata.phase)
	if (phase !== "started" && phase !== "completed" && phase !== "skipped") return undefined
	return {
		phase,
		sessionId: event.sessionId,
		reason,
		...optionalCount(event.raw, metadata, "tokensBefore"),
		...optionalCount(event.raw, metadata, "tokensAfter"),
		...optionalCount(event.raw, metadata, "messagesBefore"),
		...optionalCount(event.raw, metadata, "messagesAfter"),
		...optionalCount(event.raw, metadata, "maxInputTokens"),
		...optionalCount(event.raw, metadata, "triggerTokens"),
		...optionalCount(event.raw, metadata, "targetTokens"),
		...optionalCount(event.raw, metadata, "messageTargetTokens"),
	}
}
function optionalCount(primary: Record<string, unknown>, fallback: Record<string, unknown>, key: string) {
	const value = primary[key] ?? fallback[key]
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? { [key]: Math.round(value) } : {}
}
function statusForFinishReason(reason: string) {
	const normalized = reason.trim().toLowerCase()
	if (normalized === "aborted") return "cancelled"
	if (normalized === "error" || normalized === "mistake_limit") return "failed"
	return "completed"
}
