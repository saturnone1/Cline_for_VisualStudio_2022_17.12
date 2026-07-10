import type { AskQuestionResult, ToolApprovalResult } from "./AgentInteraction"
import type { WebviewEnvelope } from "../dto/WebviewRpc"

export interface WebviewApplicationPort {
	dispose(): void
	isScheduledAgentsEnabled(): boolean
	requestToolApproval(request: unknown): Promise<ToolApprovalResult>
	requestQuestion(question: string, options: string[]): Promise<AskQuestionResult>
	handleSdkEvent(event: unknown): void
	handle(envelope: WebviewEnvelope): Promise<unknown>
}
