import { upsertTaskHistoryItem, type TaskHistoryItem } from "./TaskHistoryCollection"
import type { TaskSnapshotStore } from "./TaskSnapshotStore"

type TaskRecord = Record<string, unknown>

type TaskStateDependencies = {
	snapshots: TaskSnapshotStore
	readCurrentTask: () => TaskRecord | null
	writeCurrentTask: (task: TaskRecord) => void
	readMessages: () => readonly TaskRecord[]
	readHistory: () => readonly TaskHistoryItem[]
	writeHistory: (history: TaskHistoryItem[]) => void
	schedulePersist: () => void
	now?: () => number
}

export class TaskStateCoordinator {
	constructor(private readonly dependencies: TaskStateDependencies) {}

	update(updates: TaskRecord = {}) {
		const currentTask = this.dependencies.readCurrentTask()
		if (!currentTask) return
		const messages = this.dependencies.readMessages()
		const task = {
			...currentTask,
			...updates,
			ts: (this.dependencies.now ?? Date.now)(),
			size: messages.length,
		}
		this.dependencies.writeCurrentTask(task)
		this.dependencies.writeHistory(upsertTaskHistoryItem(this.dependencies.readHistory(), task))
		this.remember(String(task.id || ""), task, messages)
		this.dependencies.schedulePersist()
	}

	getSnapshot(taskId: string) { return this.dependencies.snapshots.get(taskId) }

	remember(taskId: string, task: TaskRecord, messages: readonly TaskRecord[]) {
		this.dependencies.snapshots.remember(taskId, task, messages)
	}

	forget(taskId: string) { this.dependencies.snapshots.forget(taskId) }
	clearSnapshots() { this.dependencies.snapshots.clear() }
}
