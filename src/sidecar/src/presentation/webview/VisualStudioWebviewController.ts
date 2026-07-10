import type { AskQuestionResult, ToolApprovalResult } from "../../application/ports/AgentInteraction"
import type { WebviewApplicationPort } from "../../application/ports/WebviewApplicationPort"

export class VisualStudioWebviewController {
	constructor(private readonly application: WebviewApplicationPort) {}

	dispose() { this.application.dispose() }
	isScheduledAgentsEnabled() { return this.application.isScheduledAgentsEnabled() }
	requestToolApproval(request: unknown): Promise<ToolApprovalResult> { return this.application.requestToolApproval(request) }
	requestQuestion(question: string, options: string[]): Promise<AskQuestionResult> { return this.application.requestQuestion(question, options) }
	handleSdkEvent(event: unknown) { this.application.handleSdkEvent(event) }
	handle(params: unknown) { return this.application.handle(params) }
}
