import type { AskQuestionResult, ToolApprovalResult } from "../../application/ports/AgentInteraction"
import type { WebviewApplicationPort } from "../../application/ports/WebviewApplicationPort"
import {
	createHostSidecarWebviewResponse,
	parseHostSidecarWebviewRequest,
	parseWebviewEnvelope,
} from "../../application/dto/WebviewRpc"
import type { AgentRuntimeEvent } from "../../domain/agent/AgentRuntimeEvent"
import type { ApprovalRequestedEvent } from "../../domain/agent/AgentRuntimeEvent"

export class VisualStudioWebviewController {
	constructor(private readonly application: WebviewApplicationPort) {}

	dispose() { return this.application.dispose() }
	isScheduledAgentsEnabled() { return this.application.isScheduledAgentsEnabled() }
	requestToolApproval(request: ApprovalRequestedEvent): Promise<ToolApprovalResult> { return this.application.requestToolApproval(request) }
	requestQuestion(question: string, options: string[]): Promise<AskQuestionResult> { return this.application.requestQuestion(question, options) }
	handleSdkEvent(event: AgentRuntimeEvent) { this.application.handleSdkEvent(event) }
	handle(params: unknown) {
		try {
			const hostRequest = parseHostSidecarWebviewRequest(params)
			if (!hostRequest.ok) {
				return Promise.resolve(createHostSidecarWebviewResponse({ handled: false, reason: hostRequest.reason }))
			}
			const parsed = parseWebviewEnvelope(JSON.parse(hostRequest.value.rawJson))
			if (!parsed.ok) {
				return Promise.resolve(createHostSidecarWebviewResponse({ handled: false, reason: parsed.reason }))
			}
			return Promise.resolve(this.application.handle(parsed.value)).then(createHostSidecarWebviewResponse)
		} catch {
			return Promise.resolve(createHostSidecarWebviewResponse({ handled: false, reason: "invalid_webview_json" }))
		}
	}
}
