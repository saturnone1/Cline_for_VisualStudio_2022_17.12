import type { StateStorePort } from "../ports/StateStorePort"

export type StateSnapshotFactory = () => Record<string, unknown>

export class StatePersistenceUseCase {
	private timer: ReturnType<typeof setTimeout> | null = null
	private maxWaitTimer: ReturnType<typeof setTimeout> | null = null
	private scheduledSnapshotFactory: StateSnapshotFactory | null = null
	private pendingSave: Promise<void> = Promise.resolve()
	private queuedSnapshot: Record<string, unknown> | null = null
	private saveInProgress = false
	private lastError: Error | null = null

	constructor(
		private readonly store: StateStorePort,
		private readonly debounceMs = 250,
		private readonly maximumWaitMs = 5_000,
	) {}

	load() {
		return this.store.load()
	}

	save(snapshot: Record<string, unknown>) {
		try {
			this.store.save(snapshot)
			this.lastError = null
		} catch (error) {
			this.lastError = toError(error)
			throw this.lastError
		}
	}

	clear() {
		this.cancelPending()
		this.queuedSnapshot = null
		this.store.invalidatePendingWrites?.()
		try {
			this.store.clear()
			this.lastError = null
		} catch (error) {
			this.lastError = toError(error)
			throw this.lastError
		}
	}

	schedule(createSnapshot: StateSnapshotFactory) {
		this.scheduledSnapshotFactory = createSnapshot
		if (this.timer) clearTimeout(this.timer)
		this.timer = setTimeout(() => this.runScheduledSave(), this.debounceMs)
		this.timer.unref?.()
		if (!this.maxWaitTimer) {
			this.maxWaitTimer = setTimeout(
				() => this.runScheduledSave(),
				Math.max(this.debounceMs, this.maximumWaitMs),
			)
			this.maxWaitTimer.unref?.()
		}
	}

	flush(createSnapshot: StateSnapshotFactory) {
		this.cancelPending()
		this.queuedSnapshot = null
		this.store.invalidatePendingWrites?.()
		this.save(createSnapshot())
	}

	get persistenceError() { return this.lastError }

	private cancelPending() {
		if (this.timer) clearTimeout(this.timer)
		if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer)
		this.timer = null
		this.maxWaitTimer = null
		this.scheduledSnapshotFactory = null
	}

	private runScheduledSave() {
		const createSnapshot = this.scheduledSnapshotFactory
		this.cancelPending()
		if (!createSnapshot) return
		try {
			const snapshot = createSnapshot()
			if (this.store.saveDeferred) {
				this.enqueueDeferred(snapshot)
			} else {
				this.store.save(snapshot)
				this.lastError = null
			}
		} catch (error) {
			this.lastError = toError(error)
			console.error("Failed to persist LIG VS state:", this.lastError)
		}
	}

	private enqueueDeferred(snapshot: Record<string, unknown>) {
		this.queuedSnapshot = snapshot
		if (this.saveInProgress) return
		this.saveInProgress = true
		this.pendingSave = this.drainDeferred()
	}

	private async drainDeferred() {
		try {
			while (this.queuedSnapshot) {
				const snapshot = this.queuedSnapshot
				this.queuedSnapshot = null
				try {
					await this.store.saveDeferred!(snapshot)
					this.lastError = null
				} catch (error) {
					this.lastError = toError(error)
					console.error("Failed to persist deferred LIG VS state:", this.lastError)
				}
			}
		} finally {
			this.saveInProgress = false
			if (this.queuedSnapshot) this.enqueueDeferred(this.queuedSnapshot)
		}
	}
}

function toError(value: unknown) {
	return value instanceof Error ? value : new Error(String(value))
}
