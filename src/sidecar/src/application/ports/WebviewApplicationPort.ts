import type { AskQuestionResult, ToolApprovalResult } from "./AgentInteraction"
import type { WebviewEnvelope } from "../dto/WebviewRpc"
import type { AgentRuntimeEvent } from "../../domain/agent/AgentRuntimeEvent"
import type { ApprovalRequestedEvent } from "../../domain/agent/AgentRuntimeEvent"

export interface WebviewApplicationPort {
	dispose(): Promise<void>
	isScheduledAgentsEnabled(): boolean
	requestToolApproval(request: ApprovalRequestedEvent): Promise<ToolApprovalResult>
	requestQuestion(question: string, options: string[]): Promise<AskQuestionResult>
	handleSdkEvent(event: AgentRuntimeEvent): void
	handle(envelope: WebviewEnvelope): Promise<unknown>
}
