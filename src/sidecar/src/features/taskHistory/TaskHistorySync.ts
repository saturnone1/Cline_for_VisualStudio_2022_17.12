import type { TaskHistoryItem } from "./TaskHistoryCollection"

type Callbacks = Readonly<{
	isAvailable: () => boolean
	listHistory: () => Promise<unknown>
	projectSession: (session: unknown) => TaskHistoryItem
	readHistory: () => readonly TaskHistoryItem[]
	writeHistory: (history: TaskHistoryItem[]) => void
	broadcast: () => Promise<void>
	log: (event: string, details: Record<string, unknown>) => void
}>

export class TaskHistorySync {
	private readonly deletedTaskIds = new Set<string>()
	private refreshPromise: Promise<void> | null = null

	constructor(private readonly callbacks: Callbacks) {}

	isDeleted(taskId: string) { return this.deletedTaskIds.has(taskId) }
	markDeleted(taskId: string) { if (taskId) this.deletedTaskIds.add(taskId) }
	removeDeleted(history: readonly TaskHistoryItem[]) { return history.filter((item) => !this.deletedTaskIds.has(String(item.id || ""))).map((item) => ({ ...item })) }

	async refresh() {
		if (!this.callbacks.isAvailable()) return
		if (this.refreshPromise) return this.refreshPromise
		this.refreshPromise = this.refreshCore()
		try {
			await this.refreshPromise
		} finally {
			this.refreshPromise = null
		}
	}

	refreshInBackground(source: string) {
		if (!this.callbacks.isAvailable()) return
		void (async () => {
			const startedAt = Date.now()
			try {
				await this.refresh()
				this.callbacks.log("stateHydration.historyRefreshed", { source, durationMs: Date.now() - startedAt, count: this.callbacks.readHistory().length })
				await this.callbacks.broadcast()
			} catch (error) {
				this.callbacks.log("stateHydration.historyRefreshFailed", { source, error: stringify(error) })
			}
		})()
	}

	private async refreshCore() {
		const history = await this.callbacks.listHistory().catch(() => null)
		if (!Array.isArray(history)) return

		const localById = new Map(this.callbacks.readHistory().map((item) => [taskId(item), item]))
		const merged = history.map((session) => {
			const remote = this.callbacks.projectSession(session)
			const local = localById.get(taskId(remote))
			if (local) localById.delete(taskId(remote))
			return local ? { ...local, ...remote } : remote
		})
		for (const local of localById.values()) merged.push({ ...local })
		this.callbacks.writeHistory(this.removeDeleted(merged))
	}
}

function taskId(item: TaskHistoryItem) { return String(item.id || "") }
function stringify(value: unknown) { return value instanceof Error ? value.message : String(value) }
