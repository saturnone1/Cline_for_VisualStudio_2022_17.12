import type { AgentEnginePort } from "../../../application/ports/AgentEnginePort"
import type { SendMessageCommand } from "./SendMessageCommand"

export class SendMessageHandler {
	constructor(private readonly agentEngine: AgentEnginePort) {}

	execute(command: SendMessageCommand) {
		if (!command.sessionId.trim()) throw new Error("A session ID is required to send a message.")
		if (!command.prompt.trim()) throw new Error("A non-empty prompt is required to send a message.")
		return this.agentEngine.send(command)
	}
}
