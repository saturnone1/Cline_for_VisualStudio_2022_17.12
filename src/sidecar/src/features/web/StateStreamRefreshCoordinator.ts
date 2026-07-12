import type { InteractionLoggerPort } from "../../application/ports/InteractionLoggerPort"

type StateStreamRefreshDependencies = {
	logger: InteractionLoggerPort
	delayMs: () => number
	shouldSkipScheduledRefresh: () => boolean
	refreshHistory: () => Promise<unknown>
	refreshSelectedTask: () => Promise<unknown>
	broadcast: () => Promise<unknown>
	formatError: (error: unknown) => string
}

export class StateStreamRefreshCoordinator {
	private refreshInFlight = false
	private refreshTimer: NodeJS.Timeout | null = null

	constructor(private readonly dependencies: StateStreamRefreshDependencies) {}

	schedule() {
		if (this.refreshTimer) clearTimeout(this.refreshTimer)
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = null
			if (!this.dependencies.shouldSkipScheduledRefresh()) this.refreshInBackground()
		}, this.dependencies.delayMs())
		this.refreshTimer.unref?.()
	}

	refreshInBackground() {
		if (this.refreshInFlight) return
		this.refreshInFlight = true
		void this.refresh().finally(() => { this.refreshInFlight = false })
	}

	dispose() {
		if (this.refreshTimer) clearTimeout(this.refreshTimer)
		this.refreshTimer = null
	}

	private async refresh() {
		try {
			await this.dependencies.refreshHistory()
			await this.dependencies.refreshSelectedTask()
			await this.dependencies.broadcast()
		} catch (error) {
			this.dependencies.logger.log("sidecar", "stateHydrationRefreshFailed", { error: this.dependencies.formatError(error) })
		}
	}
}
