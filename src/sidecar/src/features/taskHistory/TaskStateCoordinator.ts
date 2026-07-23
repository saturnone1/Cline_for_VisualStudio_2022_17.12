import { upsertTaskHistoryItem, type TaskHistoryItem } from "./TaskHistoryCollection"
import type { TaskSnapshotStore } from "./TaskSnapshotStore"
import { taskTranscriptStorageBytes } from "./TaskHistoryStorageSize"

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
		this.write(updates, false)
	}

	capture(updates: TaskRecord = {}) {
		this.write(updates, true)
	}

	private write(updates: TaskRecord, capture: boolean) {
		const currentTask = this.dependencies.readCurrentTask()
		if (!currentTask) return
		const messages = this.dependencies.readMessages()
		const task: TaskRecord = {
			...currentTask,
			...updates,
			ts: (this.dependencies.now ?? Date.now)(),
			...(capture ? { size: taskTranscriptStorageBytes(messages) } : {}),
		}
		this.dependencies.writeCurrentTask(task)
		this.dependencies.writeHistory(upsertTaskHistoryItem(this.dependencies.readHistory(), task))
		const taskId = String(task.id || "")
		if (capture) this.remember(taskId, task, messages)
		else this.dependencies.snapshots.rememberLive(taskId, task, messages)
		this.dependencies.schedulePersist()
	}

	getSnapshot(taskId: string) { return this.dependencies.snapshots.get(taskId) }

	remember(taskId: string, task: TaskRecord, messages: readonly TaskRecord[]) {
		this.dependencies.snapshots.remember(taskId, task, messages)
	}

	forget(taskId: string) { this.dependencies.snapshots.forget(taskId) }
	clearSnapshots() { this.dependencies.snapshots.clear() }
}
