import type { InteractionLoggerPort } from "../../application/ports/InteractionLoggerPort"

type StateStreamRefreshDependencies = {
	logger: InteractionLoggerPort
	delayMs: () => number
	shouldSkipScheduledRefresh: () => boolean
	shouldContinueScheduledRefresh: () => boolean
	historyRefreshIntervalMs: () => number
	refreshHistory: () => Promise<unknown>
	refreshSelectedTask: () => Promise<unknown>
	broadcast: () => Promise<unknown>
	formatError: (error: unknown) => string
}

export class StateStreamRefreshCoordinator {
	private refreshInFlight = false
	private refreshTimer: NodeJS.Timeout | null = null
	private disposed = false
	private lastHistoryRefreshAt = 0

	constructor(private readonly dependencies: StateStreamRefreshDependencies) {}

	schedule() {
		if (this.disposed) return
		if (this.refreshTimer) clearTimeout(this.refreshTimer)
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = null
			if (!this.dependencies.shouldSkipScheduledRefresh()) this.refreshInBackground()
		}, this.dependencies.delayMs())
		this.refreshTimer.unref?.()
	}

	refreshInBackground() {
		if (this.refreshInFlight || this.disposed) return
		this.refreshInFlight = true
		void this.refresh().finally(() => {
			this.refreshInFlight = false
			if (!this.disposed && this.dependencies.shouldContinueScheduledRefresh()) this.schedule()
		})
	}

	dispose() {
		this.disposed = true
		if (this.refreshTimer) clearTimeout(this.refreshTimer)
		this.refreshTimer = null
	}

	private async refresh() {
		try {
			const now = Date.now()
			let historyRefreshed = false
			if (now - this.lastHistoryRefreshAt >= this.dependencies.historyRefreshIntervalMs()) {
				await this.dependencies.refreshHistory()
				this.lastHistoryRefreshAt = now
				historyRefreshed = true
			}
			const selectedChanged = await this.dependencies.refreshSelectedTask()
			if (historyRefreshed || selectedChanged === true) await this.dependencies.broadcast()
		} catch (error) {
			this.dependencies.logger.log("sidecar", "stateHydrationRefreshFailed", { error: this.dependencies.formatError(error) })
		}
	}
}
