import type { AskQuestionResult, ToolApprovalResult } from "../../application/ports/AgentInteraction"
import type { WebviewApplicationPort } from "../../application/ports/WebviewApplicationPort"
import { parseWebviewEnvelope } from "../../application/dto/WebviewRpc"
import type { AgentRuntimeEvent } from "../../domain/agent/AgentRuntimeEvent"
import type { ApprovalRequestedEvent } from "../../domain/agent/AgentRuntimeEvent"

export class VisualStudioWebviewController {
	constructor(private readonly application: WebviewApplicationPort) {}

	dispose() { this.application.dispose() }
	isScheduledAgentsEnabled() { return this.application.isScheduledAgentsEnabled() }
	requestToolApproval(request: ApprovalRequestedEvent): Promise<ToolApprovalResult> { return this.application.requestToolApproval(request) }
	requestQuestion(question: string, options: string[]): Promise<AskQuestionResult> { return this.application.requestQuestion(question, options) }
	handleSdkEvent(event: AgentRuntimeEvent) { this.application.handleSdkEvent(event) }
	handle(params: unknown) {
		try {
			const rawJson = readRawJson(params)
			const parsed = parseWebviewEnvelope(JSON.parse(rawJson))
			if (!parsed.ok) {
				return Promise.resolve({ handled: false, reason: parsed.reason })
			}
			return this.application.handle(parsed.value)
		} catch {
			return Promise.resolve({ handled: false, reason: "invalid_webview_json" })
		}
	}
}

function readRawJson(params: unknown) {
	if (!params || typeof params !== "object" || !("rawJson" in params)) {
		return "{}"
	}
	return String((params as { rawJson?: unknown }).rawJson ?? "{}")
}
