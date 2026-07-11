import { normalizeAssistantTranscriptText, normalizeTranscriptText } from "./ConversationSupport"

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
		const last = [...this.callbacks.messages()].reverse().find((message) => message.say === "text" && message.partial !== true)
		if (normalizeTranscriptText(readString(last?.text)) === normalizeTranscriptText(normalized)) return
		this.callbacks.addMessage({ type: "say", say: "text", text: normalized })
	}

	finish(sessionId: string, status: string, text = "") {
		this.callbacks.transition(isFailed(status) ? "failed" : "completed", `finish:${status || "completed"}`)
		this.callbacks.clearFinishStatus()
		const activeText = text || this.callbacks.activeText()
		this.callbacks.finishProgress()
		const hasAssistant = this.hasAssistantAfterLastUser(), hasFinalAssistant = this.hasAssistantAfterLastBoundary()
		if (activeText) this.addAssistantText(activeText)
		else if (!hasAssistant) {
			this.callbacks.log("emptyDoneNoFinalAssistantText", { status, lastTaskActivityReason: this.callbacks.lastActivityReason() })
			if (["completed", "idle", "ended"].includes(status.toLowerCase())) { this.callbacks.finalizeOpenPartial(); this.callbacks.persist(); return }
		} else if (!hasFinalAssistant) this.callbacks.log("doneWithPreviousAssistantTextNoFinalText", { status, lastTaskActivityReason: this.callbacks.lastActivityReason() })
		else this.callbacks.log("doneWithExistingAssistantText", { status, lastTaskActivityReason: this.callbacks.lastActivityReason() })
		this.callbacks.finalizeOpenPartial()
		this.addMarker(status)
		this.callbacks.runCompleteHook({ sessionId, status, text: activeText })
		this.callbacks.persist()
	}

	fail(sessionId: string, text: string) {
		this.callbacks.transition("failed", "finish:empty-model-response")
		this.callbacks.clearFinishStatus()
		this.callbacks.finishProgress()
		this.callbacks.finalizeOpenPartial()
		this.callbacks.addMessage({ type: "say", say: "error", text })
		this.callbacks.runCompleteHook({ sessionId, status: "failed", text })
		this.callbacks.persist()
	}

	addMarker(status: string) {
		if (this.hasCompletionAfterLastUser()) return
		const normalized = status.toLowerCase(), language = this.callbacks.language()
		const text = ["cancelled", "stopped", "aborted"].includes(normalized) ? language === "ko" ? "요청을 취소했습니다." : "Request cancelled." : ["failed", "error"].includes(normalized) ? language === "ko" ? "작업이 오류 상태로 종료되었습니다." : "Task ended with an error." : language === "ko" ? "완료" : "Done."
		this.callbacks.addMessage({ type: "say", say: "completion_result", text })
	}

	hasCompletion() { return this.callbacks.messages().some((message) => message.say === "completion_result" || message.ask === "completion_result") }
	hasCompletionAfterLastUser() { return this.callbacks.messages().slice(this.lastUserIndex() + 1).some((message) => readString(message.say) === "completion_result" || readString(message.ask) === "completion_result") }
	hasAssistantAfterLastUser() { return this.callbacks.messages().slice(this.lastUserIndex() + 1).some(isFinalAssistant) }

	terminalFallback(status: string) {
		const summary = this.callbacks.recentToolSummaries().join("\n")
		if (["failed", "error"].includes(status)) return summary ? `작업이 오류 상태로 종료되었습니다.\n\n${summary}` : "작업이 오류 상태로 종료되었습니다."
		if (["stalled", "idle-timeout"].includes(status)) return summary ? `LIG VS SDK가 일정 시간 새 진행 이벤트를 보내지 않아 작업을 중단했습니다.\n\n마지막으로 확인된 작업:\n${summary}` : "LIG VS SDK가 일정 시간 새 진행 이벤트를 보내지 않아 작업을 중단했습니다."
		if (["cancelled", "stopped", "aborted"].includes(status)) return summary ? `작업이 중단되었습니다.\n\n${summary}` : "작업이 중단되었습니다."
		return summary ? `작업이 완료되었습니다.\n\n${summary}` : "작업이 완료되었습니다."
	}

	private lastUserIndex() { return findLast(this.callbacks.messages(), (message) => readString(message.say) === "user_feedback" || readString(message.say) === "task") }
	private hasAssistantAfterLastBoundary() { const index = findLast(this.callbacks.messages(), isBoundary); return this.callbacks.messages().slice(index + 1).some(isFinalAssistant) }
}

function isFailed(status: string) { return status === "failed" || status === "error" }
function isFinalAssistant(message: Message) { return readString(message.say) === "text" && readString(message.text).trim().length > 0 && message.partial !== true }
function isBoundary(message: Message) { const say = readString(message.say), ask = readString(message.ask); if (say === "user_feedback" || say === "task" || ask === "command" || ask === "tool" || say === "tool" || say === "command_output" || say === "browser_action") return true; if (say === "reasoning") { const text = readString(message.text); return text.includes("기록") || text.includes("history") || text.includes("진행") || text.includes("Running") } return false }
function findLast(values: Message[], predicate: (value: Message) => boolean) { for (let index = values.length - 1; index >= 0; index--) if (predicate(values[index])) return index; return -1 }
function readString(value: unknown) { return typeof value === "string" ? value : "" }
