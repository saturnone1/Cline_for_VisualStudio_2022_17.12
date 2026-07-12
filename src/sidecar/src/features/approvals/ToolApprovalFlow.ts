import type { ToolApprovalResult } from "../../application/ports/AgentInteraction"
import type { ApprovalRequestedEvent } from "../../domain/agent/AgentRuntimeEvent"
import { applyPreToolUseInputPatch, type PreToolUseDecision } from "../hooks/HookPolicy"

type ApprovalPrompt = Readonly<{ ask: "command" | "tool"; text: string }>

type ToolApprovalDependencies = {
	mapToolName: (toolName: string) => string
	isPlanModeBlocked: (mappedToolName: string) => boolean
	blockedReason: () => string
	addInfo: (text: string) => void
	currentSessionId: () => string
	preToolUse: (context: Record<string, unknown>) => Promise<PreToolUseDecision>
	shouldAutoApprove: (toolName: string) => boolean
	notifyAutoApproved: (mappedToolName: string, input: Record<string, unknown>) => Promise<void>
	buildPrompt: (mappedToolName: string, input: Record<string, unknown>, approvalRequest: Record<string, unknown>) => ApprovalPrompt
	beginApproval: () => void
	addAsk: (prompt: ApprovalPrompt) => void
	updateTask: () => void
	broadcast: () => Promise<void>
	requestApproval: () => Promise<ToolApprovalResult>
	logRequest: (details: unknown) => void
	log: (event: string, details: unknown) => void
}

export class ToolApprovalFlow {
	constructor(private readonly dependencies: ToolApprovalDependencies) {}

	async execute(request: ApprovalRequestedEvent): Promise<ToolApprovalResult> {
		this.dependencies.logRequest(request)
		const approvalRequest = request.raw as Record<string, unknown>
		const input = request.input as Record<string, unknown>
		const mappedToolName = this.dependencies.mapToolName(request.toolName)

		if (this.dependencies.isPlanModeBlocked(mappedToolName)) {
			const reason = this.dependencies.blockedReason()
			this.dependencies.addInfo(reason)
			this.dependencies.updateTask()
			await this.dependencies.broadcast()
			return { approved: false, reason }
		}

		const hookDecision = await this.dependencies.preToolUse({
			sessionId: this.dependencies.currentSessionId(),
			toolName: request.toolName,
			mappedToolName,
			input,
			approvalRequest,
		})
		if (hookDecision.blocked) return { approved: false, reason: hookDecision.reason || "Blocked by PreToolUse hook." }
		if (hookDecision.inputPatch && Object.keys(hookDecision.inputPatch).length > 0) {
			applyPreToolUseInputPatch(input, approvalRequest, hookDecision)
			this.dependencies.log("preToolUseInputPatched", {
				toolName: request.toolName,
				mappedToolName,
				replaceInput: hookDecision.replaceInput === true,
				keys: Object.keys(hookDecision.inputPatch),
				reason: hookDecision.reason || undefined,
			})
		}

		if (this.dependencies.shouldAutoApprove(request.toolName)) {
			await this.dependencies.notifyAutoApproved(mappedToolName, input)
			return { approved: true, reason: "Auto-approved by Visual Studio settings." }
		}

		const prompt = this.dependencies.buildPrompt(mappedToolName, input, approvalRequest)
		this.dependencies.beginApproval()
		this.dependencies.addAsk(prompt)
		this.dependencies.updateTask()
		await this.dependencies.broadcast()
		return this.dependencies.requestApproval()
	}
}
