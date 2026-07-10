const TERMINAL_TASK_STATUSES = new Set(["completed", "stopped", "cancelled", "failed", "error"])

export type TaskLifecycleStatus = "idle" | "starting" | "streaming" | "awaiting_user" | "cancelling" | "completed" | "failed"

const ALLOWED_TRANSITIONS: Record<TaskLifecycleStatus, ReadonlySet<TaskLifecycleStatus>> = {
	idle: new Set(["starting", "streaming", "awaiting_user"]),
	starting: new Set(["streaming", "awaiting_user", "cancelling", "completed", "failed"]),
	streaming: new Set(["starting", "awaiting_user", "cancelling", "completed", "failed"]),
	awaiting_user: new Set(["starting", "streaming", "cancelling", "completed", "failed"]),
	cancelling: new Set(["completed", "failed", "idle"]),
	completed: new Set(["idle", "starting"]),
	failed: new Set(["idle", "starting"]),
}

export function isTerminalTaskStatus(status: string) {
	return TERMINAL_TASK_STATUSES.has(status.trim().toLowerCase())
}

export function canTransitionTask(from: TaskLifecycleStatus, to: TaskLifecycleStatus) {
	return from === to || ALLOWED_TRANSITIONS[from].has(to)
}

export class TaskLifecycleMachine {
	constructor(private current: TaskLifecycleStatus = "idle") {}

	get status() {
		return this.current
	}

	initialize(status: TaskLifecycleStatus) {
		this.current = status
	}

	transition(to: TaskLifecycleStatus) {
		if (this.current === "cancelling" && to === "cancelling") {
			return false
		}
		if (!canTransitionTask(this.current, to)) {
			return false
		}
		this.current = to
		return true
	}

	reset() {
		this.current = "idle"
	}
}
