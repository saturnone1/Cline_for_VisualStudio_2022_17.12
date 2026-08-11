import type { CheckpointHandler, CheckpointTargetRequest } from "./CheckpointHandler"
import { throwIfOperationCancelled } from "../../application/services/OperationCancellation"

export type CheckpointCommand =
	| Readonly<{ type: "restore"; target: CheckpointTargetRequest }>
	| Readonly<{ type: "diff"; target: CheckpointTargetRequest }>

export type CheckpointRpcResult = Readonly<{ payload: Record<string, unknown>; includeStateMessages?: boolean }>

type Callbacks = Readonly<{
	available: () => boolean
	checkpoints: () => CheckpointHandler
	currentTask: () => Record<string, unknown> | null
	messages: () => readonly Record<string, unknown>[]
	workspaceRoot: () => Promise<string>
	buildConfig: (cwd: string, sessionId: string) => Promise<Readonly<Record<string, unknown>>>
	toolPolicies: () => Readonly<Record<string, unknown>>
	showTask: (taskId: string) => Promise<void>
	addInfo: (text: string, checkpointRunCount?: number) => void
	updateTask: () => void
	broadcast: () => Promise<void>
	trackedChanges: () => readonly Record<string, unknown>[]
}>

export class CheckpointRpcHandler {
	constructor(private readonly callbacks: Callbacks) {}

	async handle(command: CheckpointCommand, signal?: AbortSignal): Promise<CheckpointRpcResult> {
		throwIfOperationCancelled(signal)
		if (command.type === "restore") {
			await this.restore(command.target, signal)
			return { payload: { value: true } }
		}
		const description = await this.callbacks.checkpoints().compare(command.target, { taskItem: this.callbacks.currentTask() || undefined, messages: this.callbacks.messages(), trackedChanges: this.callbacks.trackedChanges() })
		if (description.success) {
			this.callbacks.addInfo(description.text, description.checkpointRunCount)
			this.callbacks.updateTask()
		}
		return { payload: description, includeStateMessages: true }
	}

	private async restore(target: CheckpointTargetRequest, signal?: AbortSignal) {
		const task = this.callbacks.currentTask()
		if (!this.callbacks.available() || !task) throw new Error("No SDK-backed task is selected for checkpoint restore.")
		const cwd = await this.callbacks.workspaceRoot()
		throwIfOperationCancelled(signal)
		const sessionId = readString(task.id)
		const config = await this.callbacks.buildConfig(cwd, sessionId)
		throwIfOperationCancelled(signal)
		const result = await this.callbacks.checkpoints().restore(target, { taskItem: task, messages: this.callbacks.messages(), cwd, config, toolPolicies: this.callbacks.toolPolicies() })
		if (result.restoredSessionId) await this.callbacks.showTask(result.restoredSessionId)
		else {
			this.callbacks.addInfo("Checkpoint workspace restore completed.")
			await this.callbacks.broadcast()
		}
	}
}

function readString(value: unknown) { return typeof value === "string" ? value : value == null ? "" : String(value) }
