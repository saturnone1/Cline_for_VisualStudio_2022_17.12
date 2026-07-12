import type { ConversationProjectionState, ProgressPhase } from "../../features/conversation/ConversationProjectionState"
import { isEmptyTranscriptPlaceholder, normalizeProgressTranscriptText, normalizeReasoningTranscriptText, sanitizeProgressTranscriptForDisplay } from "./ConversationSupport"
import { normalizeTranscriptText } from "./TranscriptTextPolicy"

type Message = Record<string, unknown>

export class FoldedProgressProjector {
	constructor(
		private readonly projection: ConversationProjectionState,
		private readonly messages: () => Message[],
		private readonly nextTimestamp: () => number,
		private readonly upsertMessage: (timestamp: number, updates: Message) => void,
		private readonly sendPartial: (message?: Message) => void,
		private readonly broadcastNow: () => void,
		private readonly scheduleBroadcast: () => void,
		private readonly stopTerminal: () => void,
		private readonly language: () => "en" | "ko",
	) {}

	upsertReasoning(text: string) {
		const normalized = normalizeReasoningTranscriptText(text)
		if (!normalized || isEmptyTranscriptPlaceholder(normalized)) return
		this.beginPhase("reasoning")
		const limit = readPositiveIntEnv("VSCLINE_REASONING_TRANSCRIPT_CHARS", 12000), capped = truncateText(normalized, limit)
		const previous = this.projection.activeFoldedReasoningText, previousNormalized = normalizeTranscriptText(previous), cappedNormalized = normalizeTranscriptText(capped)
		if (previousNormalized.includes(cappedNormalized) || (!this.projection.activeReasoningTextTs && this.hasRecentReasoning(capped))) return
		this.projection.activeFoldedReasoningText = truncateText(cappedNormalized.includes(previousNormalized) ? capped : [previous, capped].filter(Boolean).join("\n"), limit)
		this.upsertProgressMessage()
	}

	upsertActivity(text: string) {
		const normalized = normalizeProgressTranscriptText(text)
		if (!normalized || isEmptyTranscriptPlaceholder(normalized)) return
		this.beginPhase("activity")
		this.projection.activeFoldedActivityText = truncateText(normalized, readPositiveIntEnv("VSCLINE_AGENT_TRANSCRIPT_CHARS", 12000))
		this.upsertProgressMessage()
	}

	appendTerminal(text: string) {
		const normalized = normalizeProgressTranscriptText(text)
		if (!normalized || isEmptyTranscriptPlaceholder(normalized)) return
		this.beginPhase("terminal")
		const previous = this.projection.activeTerminalActivityText, previousNormalized = normalizeTranscriptText(previous), nextNormalized = normalizeTranscriptText(normalized)
		if (previousNormalized.includes(nextNormalized)) return
		this.projection.activeTerminalActivityText = truncateText([nextNormalized.includes(previousNormalized) ? "" : previous, normalized].filter(Boolean).join("\n\n"), readPositiveIntEnv("VSCLINE_TERMINAL_ACTIVITY_CHARS", 2000))
		this.upsertProgressMessage()
	}

	refresh() { this.upsertProgressMessage() }
	beginReasoning() { this.beginPhase("reasoning") }

	finish(stopTerminalPolling = true) {
		if (stopTerminalPolling) this.stopTerminal()
		const timestamp = this.projection.activeReasoningTextTs
		if (!timestamp) return
		const message = this.messages().find((item) => item.ts === timestamp)
		if (isEmptyTranscriptPlaceholder(readString(message?.reasoning) || readString(message?.text))) {
			this.upsertMessage(timestamp, { text: "", reasoning: "", partial: false, isCollapsed: true, isExpanded: false })
			this.sendPartial(this.messages().find((item) => item.ts === timestamp))
			this.projection.finishProgressMessage()
			return
		}
		this.upsertMessage(timestamp, { text: this.title(true), reasoning: sanitizeProgressTranscriptForDisplay(readString(message?.reasoning)), partial: false, isCollapsed: true, isExpanded: false })
		this.sendPartial(this.messages().find((item) => item.ts === timestamp))
		this.projection.finishProgressMessage()
	}

	private beginPhase(phase: ProgressPhase) {
		const previous = this.projection.activeProgressPhase
		if (previous && previous !== phase) this.finish(false)
		this.projection.beginProgressPhase(phase)
	}

	private upsertProgressMessage() {
		const text = this.projection.foldedProgressText
		if (!text.trim() || isEmptyTranscriptPlaceholder(text)) return
		let created = false
		if (!this.projection.activeReasoningTextTs) {
			created = true
			this.projection.activeReasoningTextTs = this.nextTimestamp()
			this.messages().push({ ts: this.projection.activeReasoningTextTs, type: "say", say: "reasoning", text: this.title(), reasoning: text, partial: true, isCollapsed: true, isExpanded: false })
		} else this.upsertMessage(this.projection.activeReasoningTextTs, { type: "say", say: "reasoning", text: this.title(), reasoning: text, partial: true, isCollapsed: true, isExpanded: false })
		this.moveActiveToEnd()
		const message = this.messages().find((item) => item.ts === this.projection.activeReasoningTextTs)
		if (created) this.broadcastNow(); else { this.sendPartial(message); this.scheduleBroadcast() }
	}

	moveActiveToEnd() {
		const timestamp = this.projection.activeReasoningTextTs
		if (!timestamp) return
		const messages = this.messages(), index = messages.findIndex((message) => message.ts === timestamp)
		if (index >= 0 && index !== messages.length - 1) messages.push(...messages.splice(index, 1))
	}

	private hasRecentReasoning(text: string) {
		const normalized = normalizeTranscriptText(text)
		if (!normalized) return true
		return this.messages().slice(-6).some((message) => { if (readString(message.say) !== "reasoning") return false; const existing = normalizeTranscriptText(readString(message.reasoning)); return existing === normalized || existing.includes(normalized) || normalized.includes(existing) })
	}

	private title(completed = false) {
		const ko = this.language() === "ko", suffix = completed ? (ko ? " 기록" : " history") : (ko ? " 중..." : "...")
		switch (this.projection.activeProgressPhase) {
			case "terminal": return ko ? `터미널 실행${suffix}` : `Running terminal${suffix}`
			case "activity": return ko ? `파일/도구 처리${suffix}` : `Reading files and using tools${suffix}`
			default: return ko ? `응답 준비${suffix}` : `Preparing response${suffix}`
		}
	}
}

function readString(value: unknown) { return typeof value === "string" ? value : "" }
function truncateText(value: string, limit: number) { return value.length <= limit ? value : `${value.slice(0, limit)}\n\n[truncated ${value.length - limit} chars]` }
function readPositiveIntEnv(name: string, fallback: number) { const value = Number(process.env[name]); return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback }
