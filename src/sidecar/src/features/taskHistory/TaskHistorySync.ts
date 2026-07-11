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
	private refreshInFlight = false

	constructor(private readonly callbacks: Callbacks) {}

	isDeleted(taskId: string) { return this.deletedTaskIds.has(taskId) }
	markDeleted(taskId: string) { if (taskId) this.deletedTaskIds.add(taskId) }
	removeDeleted(history: readonly TaskHistoryItem[]) { return history.filter((item) => !this.deletedTaskIds.has(String(item.id || ""))).map((item) => ({ ...item })) }

	async refresh() {
		if (!this.callbacks.isAvailable()) return
		const history = await this.callbacks.listHistory().catch(() => null)
		if (!Array.isArray(history)) return
		this.callbacks.writeHistory(this.removeDeleted(history.map(this.callbacks.projectSession)))
	}

	refreshInBackground(source: string) {
		if (!this.callbacks.isAvailable() || this.refreshInFlight) return
		this.refreshInFlight = true
		void (async () => {
			const startedAt = Date.now()
			try {
				await this.refresh()
				this.callbacks.log("stateHydration.historyRefreshed", { source, durationMs: Date.now() - startedAt, count: this.callbacks.readHistory().length })
				await this.callbacks.broadcast()
			} catch (error) {
				this.callbacks.log("stateHydration.historyRefreshFailed", { source, error: stringify(error) })
			} finally {
				this.refreshInFlight = false
			}
		})()
	}
}

function stringify(value: unknown) { return value instanceof Error ? value.message : String(value) }
