export type TaskSnapshot = { taskItem: Record<string, unknown>; messages: Array<Record<string, unknown>> }

export class TaskSnapshotStore {
	private snapshots: Record<string, TaskSnapshot> = {}
	constructor(initial: unknown, private readonly onChanged: (snapshots: Record<string, TaskSnapshot>) => void) {
		for (const [taskId, value] of Object.entries(asRecord(initial))) { const snapshot = clone(value); if (snapshot) this.snapshots[taskId] = snapshot }
	}

	get(taskId: string) { const snapshot = this.snapshots[taskId]; return snapshot ? clone(snapshot) : null }

	remember(taskId: string, taskItem: Record<string, unknown>, messages: readonly Record<string, unknown>[]) {
		if (!taskId) return
		this.snapshots = {
			...this.snapshots,
			[taskId]: { taskItem: { ...taskItem }, messages: messages.map((message) => ({ ...message })) },
		}
		this.publish()
	}

	rememberLive(taskId: string, taskItem: Record<string, unknown>, messages: readonly Record<string, unknown>[]) {
		if (!taskId) return
		this.snapshots = {
			...this.snapshots,
			[taskId]: { taskItem: { ...taskItem }, messages: messages as Array<Record<string, unknown>> },
		}
		this.publish()
	}

	forget(taskId: string) {
		if (!(taskId in this.snapshots)) return
		const { [taskId]: _removed, ...remaining } = this.snapshots
		this.snapshots = remaining
		this.publish()
	}
	clear() { if (Object.keys(this.snapshots).length) { this.snapshots = {}; this.publish() } }

	private publish() { this.onChanged(this.snapshots) }
}

function clone(value: unknown): TaskSnapshot | null { const record = asRecord(value), taskItem = asRecord(record.taskItem); if (!Object.keys(taskItem).length) return null; return { taskItem: { ...taskItem }, messages: Array.isArray(record.messages) ? record.messages.map(asRecord).map((message) => ({ ...message })) : [] } }
function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
