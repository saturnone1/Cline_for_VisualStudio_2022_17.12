import type { AskQuestionResult, ToolApprovalResult } from "../../application/ports/AgentInteraction"
import type { WebviewApplicationPort } from "../../application/ports/WebviewApplicationPort"
import type { WebviewEnvelope } from "../../application/dto/WebviewRpc"

export class VisualStudioWebviewController {
	constructor(private readonly application: WebviewApplicationPort) {}

	dispose() { this.application.dispose() }
	isScheduledAgentsEnabled() { return this.application.isScheduledAgentsEnabled() }
	requestToolApproval(request: unknown): Promise<ToolApprovalResult> { return this.application.requestToolApproval(request) }
	requestQuestion(question: string, options: string[]): Promise<AskQuestionResult> { return this.application.requestQuestion(question, options) }
	handleSdkEvent(event: unknown) { this.application.handleSdkEvent(event) }
	handle(params: unknown) {
		try {
			const rawJson = readRawJson(params)
			return this.application.handle(JSON.parse(rawJson) as WebviewEnvelope)
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
