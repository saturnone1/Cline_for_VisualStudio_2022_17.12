export type TaskSnapshot = { taskItem: Record<string, unknown>; messages: Array<Record<string, unknown>> }

export class TaskSnapshotStore {
	private readonly snapshots = new Map<string, TaskSnapshot>()
	constructor(initial: unknown, private readonly onChanged: (snapshots: Record<string, TaskSnapshot>) => void) {
		for (const [taskId, value] of Object.entries(asRecord(initial))) { const snapshot = clone(value); if (snapshot) this.snapshots.set(taskId, snapshot) }
	}

	get(taskId: string) { const snapshot = this.snapshots.get(taskId); return snapshot ? clone(snapshot) : null }

	remember(taskId: string, taskItem: Record<string, unknown>, messages: readonly Record<string, unknown>[]) {
		if (!taskId) return
		this.snapshots.set(taskId, { taskItem: { ...taskItem }, messages: messages.map((message) => ({ ...message })) })
		this.publish()
	}

	forget(taskId: string) { if (this.snapshots.delete(taskId)) this.publish() }
	clear() { if (this.snapshots.size) { this.snapshots.clear(); this.publish() } }

	private publish() { this.onChanged(Object.fromEntries([...this.snapshots].map(([id, snapshot]) => [id, clone(snapshot)!]))) }
}

function clone(value: unknown): TaskSnapshot | null { const record = asRecord(value), taskItem = asRecord(record.taskItem); if (!Object.keys(taskItem).length) return null; return { taskItem: { ...taskItem }, messages: Array.isArray(record.messages) ? record.messages.map(asRecord).map((message) => ({ ...message })) : [] } }
function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
