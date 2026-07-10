const TERMINAL_TASK_STATUSES = new Set(["completed", "stopped", "cancelled", "failed", "error"])

export type TaskLifecycleStatus = "idle" | "starting" | "streaming" | "awaiting_user" | "cancelling" | "completed" | "failed"

const ALLOWED_TRANSITIONS: Record<TaskLifecycleStatus, ReadonlySet<TaskLifecycleStatus>> = {
	idle: new Set(["starting"]),
	starting: new Set(["streaming", "awaiting_user", "cancelling", "completed", "failed"]),
	streaming: new Set(["awaiting_user", "cancelling", "completed", "failed"]),
	awaiting_user: new Set(["streaming", "cancelling", "completed", "failed"]),
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
