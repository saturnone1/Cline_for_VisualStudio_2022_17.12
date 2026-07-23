import type { ScheduledAgentSpecInput } from "../../application/ports/ScheduledAgentStorePort"
import type { ScheduledAgentHandler } from "./ScheduledAgentHandler"
import { throwIfOperationCancelled } from "../../application/services/OperationCancellation"

export type ScheduledAgentCommand =
	| Readonly<{ type: "list" }>
	| Readonly<{ type: "save"; request: ScheduledAgentSpecInput }>
	| Readonly<{ type: "delete"; request: ScheduledAgentSpecInput }>
	| Readonly<{ type: "run"; request: ScheduledAgentSpecInput }>

export type ScheduledAgentRpcResult = Readonly<{ payload: Record<string, unknown>; includeStateMessages?: boolean }>

type Callbacks = Readonly<{
	agents: () => ScheduledAgentHandler
	workspaceRoot: () => Promise<string>
	launch: (request: Readonly<{ text: string; workspacePath: string; taskSessionId: string }>) => Promise<void>
}>

export class ScheduledAgentRpcHandler {
	constructor(private readonly callbacks: Callbacks) {}

	async handle(command: ScheduledAgentCommand, signal?: AbortSignal): Promise<ScheduledAgentRpcResult> {
		const workspaceRoot = await this.callbacks.workspaceRoot()
		throwIfOperationCancelled(signal)
		switch (command.type) {
			case "list": return { payload: this.callbacks.agents().list(workspaceRoot) }
			case "save": return { payload: this.callbacks.agents().save(command.request, workspaceRoot) }
			case "delete": return { payload: this.callbacks.agents().delete(command.request, workspaceRoot) }
			case "run": return { payload: await this.callbacks.agents().run(command.request, workspaceRoot, this.callbacks.launch), includeStateMessages: true }
		}
	}
}
