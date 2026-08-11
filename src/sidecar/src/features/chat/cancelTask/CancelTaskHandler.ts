import type { AgentEnginePort } from "../../../application/ports/AgentEnginePort"
import type { CancelTaskCommand } from "./CancelTaskCommand"

export class CancelTaskHandler {
	constructor(private readonly agentEngine: AgentEnginePort) {}

	async execute(command: CancelTaskCommand) {
		if (!command.sessionId.trim()) return { cancelled: false, sessionId: "" }
		await this.agentEngine.abort(command)
		this.agentEngine.markSessionInactive(command.sessionId)
		return { cancelled: true, sessionId: command.sessionId }
	}
}
