import type { AskQuestionResult, ToolApprovalResult } from "./AgentInteraction"

export interface WebviewApplicationPort {
	dispose(): void
	isScheduledAgentsEnabled(): boolean
	requestToolApproval(request: unknown): Promise<ToolApprovalResult>
	requestQuestion(question: string, options: string[]): Promise<AskQuestionResult>
	handleSdkEvent(event: unknown): void
	handle(params: unknown): Promise<unknown>
}
