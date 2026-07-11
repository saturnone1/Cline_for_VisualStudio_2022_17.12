import type { ToolApprovalResult } from "../../../application/ports/AgentInteraction"

export type AskResponseInteractionInput = Readonly<{ responseType: string; text: string; answerText: string; images: string[]; files: string[]; activeSessionId: string }>
type ApprovalResolver = (result: ToolApprovalResult) => void
type QuestionResolver = (answer: string) => void
type Callbacks = Readonly<{
	hasPendingApproval: () => boolean
	hasPendingQuestion: () => boolean
	takeApproval: () => ApprovalResolver | undefined
	takeQuestion: () => QuestionResolver | undefined
	transitionStreaming: (source: string) => void
	removeFollowup: () => void
	addFeedback: (text: string, images: string[], files: string[]) => void
	updateTask: () => void
	broadcast: () => Promise<void>
	log: (event: string, details: Record<string, unknown>) => void
}>

export class AskResponseInteractionFlow {
	constructor(private readonly callbacks: Callbacks) {}

	async handle(input: AskResponseInteractionInput) {
		if (this.callbacks.hasPendingApproval() && input.activeSessionId) {
			this.callbacks.transitionStreaming("approval-response")
			const approved = input.responseType === "yesButtonClicked", feedback = input.text.trim(), pending = this.callbacks.takeApproval()
			this.callbacks.log("sendAskResponse.pendingApproval", { approved, activeSessionId: input.activeSessionId })
			this.callbacks.addFeedback(feedback || (approved ? "승인됨" : "거부됨"), input.images, input.files)
			this.callbacks.updateTask()
			await this.callbacks.broadcast()
			pending?.({ approved, reason: feedback || (approved ? "Visual Studio에서 승인됨." : "Visual Studio에서 거부됨.") })
			return true
		}
		if (this.callbacks.hasPendingQuestion() && input.activeSessionId) {
			this.callbacks.transitionStreaming("question-response")
			const pending = this.callbacks.takeQuestion()
			this.callbacks.log("sendAskResponse.pendingQuestion", { activeSessionId: input.activeSessionId, answerLength: input.answerText.length })
			this.callbacks.removeFollowup()
			this.callbacks.addFeedback(input.answerText.trim() || "No response.", input.images, input.files)
			this.callbacks.updateTask()
			await this.callbacks.broadcast()
			pending?.(input.answerText.trim())
			return true
		}
		return false
	}
}
