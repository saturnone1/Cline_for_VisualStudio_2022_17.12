import type { AgentEnginePort } from "../../../application/ports/AgentEnginePort"
import type { StartTaskCommand } from "./StartTaskCommand"

export class StartTaskHandler {
	constructor(private readonly agentEngine: AgentEnginePort) {}

	execute(command: StartTaskCommand) {
		if (!command.prompt.trim()) throw new Error("A non-empty prompt is required to start a task.")
		if (!command.cwd.trim()) throw new Error("A working directory is required to start a task.")
		return this.agentEngine.startSession(command)
	}
}
