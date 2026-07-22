import type { StateStorePort } from "../ports/StateStorePort"

export type StateSnapshotFactory = () => Record<string, unknown>

export class StatePersistenceUseCase {
	private timer: ReturnType<typeof setTimeout> | null = null
	private pendingSave: Promise<void> = Promise.resolve()
	private lastError: Error | null = null

	constructor(
		private readonly store: StateStorePort,
		private readonly debounceMs = 250,
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
		if (this.timer) {
			return
		}
		this.timer = setTimeout(() => {
			this.timer = null
			const snapshot = createSnapshot()
			if (this.store.saveDeferred) {
				this.pendingSave = this.pendingSave
					.catch(() => undefined)
					.then(() => this.store.saveDeferred!(snapshot))
					.then(() => { this.lastError = null })
					.catch((error) => {
						this.lastError = toError(error)
						console.error("Failed to persist deferred LIG VS state:", this.lastError)
					})
			} else {
				try {
					this.store.save(snapshot)
					this.lastError = null
				} catch (error) {
					this.lastError = toError(error)
					console.error("Failed to persist LIG VS state:", this.lastError)
				}
			}
		}, this.debounceMs)
		this.timer.unref?.()
	}

	flush(createSnapshot: StateSnapshotFactory) {
		this.cancelPending()
		this.store.invalidatePendingWrites?.()
		this.save(createSnapshot())
	}

	get persistenceError() { return this.lastError }

	private cancelPending() {
		if (!this.timer) {
			return
		}
		clearTimeout(this.timer)
		this.timer = null
	}
}

function toError(value: unknown) {
	return value instanceof Error ? value : new Error(String(value))
}
