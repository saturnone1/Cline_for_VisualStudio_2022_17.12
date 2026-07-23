import { normalizeAssistantTranscriptText } from "./TranscriptNormalization"
import { normalizeTranscriptText } from "./TranscriptTextPolicy"
import { terminalTaskOutcome } from "../../domain/task/TaskLifecycle"
import { projectAssistantTranscript } from "./StructuredAssistantResponse"

type Message = Record<string, unknown>
type Callbacks = Readonly<{
	messages: () => Message[]
	transition: (status: "failed" | "completed", source: string) => void
	clearFinishStatus: () => void
	finishProgress: () => void
	prepareAssistant: () => void
	activeText: () => string
	addMessage: (message: Message) => void
	markAssistantLatency: (textLength: number) => void
	finalizeOpenPartial: () => void
	lastActivityReason: () => string
	runCompleteHook: (context: Record<string, unknown>) => void
	capture: () => void
	persist: () => void
	language: () => "en" | "ko"
	recentToolSummaries: () => string[]
	log: (event: string, details: Record<string, unknown>) => void
}>

export class TaskCompletionProjector {
	constructor(private readonly callbacks: Callbacks) {}

	addAssistantText(text: string) {
		this.callbacks.prepareAssistant()
		const normalized = normalizeAssistantTranscriptText(text || "")
		if (!normalized) return
		this.callbacks.markAssistantLatency(normalized.length)
		const projected = projectAssistantTranscript(normalized)
		const last = [...this.callbacks.messages()].reverse().find((message) => isAssistantTranscript(message) && message.partial !== true)
		if (readString(last?.say) === readString(projected.say) && readString(last?.ask) === readString(projected.ask) && normalizeTranscriptText(readString(last?.text)) === normalizeTranscriptText(readString(projected.text))) return
		this.callbacks.addMessage(projected)
	}

	finish(sessionId: string, status: string, text = "") {
		const activeText = text || this.callbacks.activeText()
		const hasAssistant = this.hasAssistantAfterLastUser(), hasFinalAssistant = this.hasAssistantAfterLastBoundary()
		const outcome = terminalTaskOutcome(status)
		const toolSummaries = this.callbacks.recentToolSummaries()
		if (outcome !== "failed" && outcome !== "cancelled" && !activeText && !hasFinalAssistant && toolSummaries.length === 0) {
			this.callbacks.log("terminalWithoutCompletionEvidence", { status, hasAssistant, lastTaskActivityReason: this.callbacks.lastActivityReason() })
			this.fail(sessionId, this.callbacks.language() === "ko" ? "모델 실행이 최종 응답이나 확인 가능한 작업 결과 없이 종료되었습니다." : "The model run ended without a final response or verifiable task result.")
			return
		}
		this.callbacks.transition(outcome === "failed" ? "failed" : "completed", `finish:${status || "completed"}`)
		this.callbacks.clearFinishStatus()
		this.callbacks.finishProgress()
		if (activeText) this.addAssistantText(activeText)
		else if (!hasFinalAssistant && toolSummaries.length > 0) this.addAssistantText(this.terminalFallback(status, toolSummaries))
		else if (!hasAssistant) {
			this.callbacks.log("emptyDoneNoFinalAssistantText", { status, lastTaskActivityReason: this.callbacks.lastActivityReason() })
		} else if (!hasFinalAssistant) this.callbacks.log("doneWithPreviousAssistantTextNoFinalText", { status, lastTaskActivityReason: this.callbacks.lastActivityReason() })
		else this.callbacks.log("doneWithExistingAssistantText", { status, lastTaskActivityReason: this.callbacks.lastActivityReason() })
		this.callbacks.finalizeOpenPartial()
		this.addMarker(status)
		this.callbacks.runCompleteHook({ sessionId, status, text: activeText })
		this.callbacks.capture()
		this.callbacks.persist()
	}

	fail(sessionId: string, text: string) {
		this.callbacks.transition("failed", "finish:empty-model-response")
		this.callbacks.clearFinishStatus()
		this.callbacks.finishProgress()
		this.callbacks.finalizeOpenPartial()
		this.callbacks.addMessage({ type: "say", say: "error", text })
		this.callbacks.runCompleteHook({ sessionId, status: "failed", text })
		this.callbacks.capture()
		this.callbacks.persist()
	}

	addMarker(status: string) {
		if (this.hasCompletionAfterLastUser()) return
		const outcome = terminalTaskOutcome(status), language = this.callbacks.language()
		const text = outcome === "cancelled" ? language === "ko" ? "요청을 취소했습니다." : "Request cancelled." : outcome === "failed" ? language === "ko" ? "작업이 오류 상태로 종료되었습니다." : "Task ended with an error." : language === "ko" ? "완료" : "Done."
		this.callbacks.addMessage({ type: "say", say: "completion_result", text })
	}

	hasCompletion() { return this.callbacks.messages().some((message) => message.say === "completion_result" || message.ask === "completion_result") }
	hasCompletionAfterLastUser() { return this.callbacks.messages().slice(this.lastUserIndex() + 1).some((message) => readString(message.say) === "completion_result" || readString(message.ask) === "completion_result") }
	hasAssistantAfterLastUser() { return this.callbacks.messages().slice(this.lastUserIndex() + 1).some(isFinalAssistant) }

	terminalFallback(status: string, summaries = this.callbacks.recentToolSummaries()) {
		const summary = summaries.join("\n"), outcome = terminalTaskOutcome(status), korean = this.callbacks.language() === "ko"
		const heading = outcome === "failed"
			? korean ? "작업이 오류 상태로 종료되었습니다." : "Task ended with an error."
			: outcome === "stalled"
				? korean ? "LIG VS SDK에서 일정 시간 새 진행 이벤트가 없어 작업을 중단했습니다." : "The task stopped because the LIG VS SDK produced no new progress events."
				: outcome === "cancelled"
					? korean ? "작업이 중단되었습니다." : "The task was cancelled."
					: korean ? "작업이 완료되었습니다." : "The task completed."
		if (!summary) return heading
		const summaryLabel = korean ? "마지막으로 확인된 작업:" : "Last observed activity:"
		return `${heading}\n\n${summaryLabel}\n${summary}`
	}

	private lastUserIndex() { return findLast(this.callbacks.messages(), (message) => readString(message.say) === "user_feedback" || readString(message.say) === "task") }
	private hasAssistantAfterLastBoundary() { const index = findLast(this.callbacks.messages(), isBoundary); return this.callbacks.messages().slice(index + 1).some(isFinalAssistant) }
}

function isFinalAssistant(message: Message) { return isAssistantTranscript(message) && readString(message.text).trim().length > 0 && message.partial !== true }
function isAssistantTranscript(message: Message) { return readString(message.say) === "text" || readString(message.ask) === "followup" }
function isBoundary(message: Message) { const say = readString(message.say), ask = readString(message.ask); return say === "user_feedback" || say === "task" || ask === "command" || ask === "tool" || say === "tool" || say === "command_output" || say === "browser_action" }
function findLast(values: Message[], predicate: (value: Message) => boolean) { for (let index = values.length - 1; index >= 0; index--) if (predicate(values[index])) return index; return -1 }
function readString(value: unknown) { return typeof value === "string" ? value : "" }
