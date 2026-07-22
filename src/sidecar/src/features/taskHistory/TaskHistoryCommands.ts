import { setTaskHistoryFavorite, type TaskHistoryItem } from "./TaskHistoryCollection"

type Snapshot = { taskItem: Record<string, unknown>; messages: Array<Record<string, unknown>> }
type Callbacks = Readonly<{
	readHistory: () => readonly TaskHistoryItem[]
	writeHistory: (history: TaskHistoryItem[]) => void
	readCurrentTask: () => TaskHistoryItem | null
	writeCurrentTask: (task: TaskHistoryItem | null) => void
	clearMessages: () => void
	clearLiveInteraction: (reason: string) => void
	markDeleted: (taskId: string) => void
	removeDeleted: (history: readonly TaskHistoryItem[]) => TaskHistoryItem[]
	listRemoteTaskIds: () => Promise<string[]>
	deleteRemote: (taskId: string) => Promise<unknown>
	updateRemoteFavorite: (taskId: string, isFavorited: boolean) => Promise<unknown>
	getSnapshot: (taskId: string) => Snapshot | null
	rememberSnapshot: (taskId: string, task: Record<string, unknown>, messages: readonly Record<string, unknown>[]) => void
	forgetSnapshot: (taskId: string) => void
	clearSnapshots: () => void
	persist: () => void
	log: (event: string, details: Record<string, unknown>) => void
}>

export class TaskHistoryCommands {
	constructor(private readonly callbacks: Callbacks) {}

	async delete(taskIds: readonly string[]) {
		const ids = new Set(taskIds.filter(Boolean))
		if (!ids.size) return
		for (const id of ids) {
			this.callbacks.markDeleted(id)
			const deleted = await this.callbacks.deleteRemote(id).catch((error) => {
				this.callbacks.log("deleteSessionFailed", { sessionId: id, error: stringify(error) })
				return false
			})
			this.callbacks.log("deleteSessionRequested", { sessionId: id, deleted })
			this.callbacks.forgetSnapshot(id)
		}
		this.callbacks.writeHistory(this.callbacks.removeDeleted(this.callbacks.readHistory()))
		if (ids.has(taskId(this.callbacks.readCurrentTask()))) this.clearSelectedTask("deleteTasks")
		this.callbacks.persist()
	}

	async deleteAll() {
		const ids = new Set(this.callbacks.readHistory().map((item) => taskId(item)).filter(Boolean))
		for (const id of await this.callbacks.listRemoteTaskIds().catch((error) => {
			this.callbacks.log("deleteAllListHistoryFailed", { error: stringify(error) })
			return []
		})) ids.add(id)
		for (const id of ids) {
			this.callbacks.markDeleted(id)
			await this.callbacks.deleteRemote(id).catch((error) => {
				this.callbacks.log("deleteAllSessionFailed", { sessionId: id, error: stringify(error) })
				return false
			})
		}
		this.callbacks.clearSnapshots()
		this.callbacks.writeHistory([])
		if (ids.has(taskId(this.callbacks.readCurrentTask()))) this.clearSelectedTask("deleteAllTasks")
		if (!this.callbacks.readCurrentTask()) this.callbacks.clearMessages()
		this.callbacks.persist()
	}

	async toggleFavorite(taskIdValue: string, isFavorited: boolean) {
		if (!taskIdValue) return
		this.callbacks.writeHistory(setTaskHistoryFavorite(this.callbacks.readHistory(), taskIdValue, isFavorited))
		const snapshot = this.callbacks.getSnapshot(taskIdValue)
		if (snapshot) this.callbacks.rememberSnapshot(taskIdValue, { ...snapshot.taskItem, isFavorited }, snapshot.messages)
		const current = this.callbacks.readCurrentTask()
		if (current?.id === taskIdValue) this.callbacks.writeCurrentTask({ ...current, isFavorited })
		this.callbacks.persist()
		try {
			await this.callbacks.updateRemoteFavorite(taskIdValue, isFavorited)
		} catch (error) {
			this.callbacks.log("updateSessionFavoriteFailed", { sessionId: taskIdValue, isFavorited, error: stringify(error) })
			throw error
		}
	}

	private clearSelectedTask(reason: string) {
		this.callbacks.clearLiveInteraction(reason)
		this.callbacks.writeCurrentTask(null)
		this.callbacks.clearMessages()
	}
}

function taskId(item: TaskHistoryItem | null) { return String(item?.id || "") }
function stringify(value: unknown) { return value instanceof Error ? value.message : String(value) }
