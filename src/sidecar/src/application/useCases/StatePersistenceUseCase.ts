import type { StateStorePort } from "../ports/StateStorePort"

export type StateSnapshotFactory = () => Record<string, unknown>

export class StatePersistenceUseCase {
	private timer: ReturnType<typeof setTimeout> | null = null

	constructor(
		private readonly store: StateStorePort,
		private readonly debounceMs = 250,
	) {}

	load() {
		return this.store.load()
	}

	save(snapshot: Record<string, unknown>) {
		this.store.save(snapshot)
	}

	clear() {
		this.cancelPending()
		this.store.clear()
	}

	schedule(createSnapshot: StateSnapshotFactory) {
		if (this.timer) {
			return
		}
		this.timer = setTimeout(() => {
			this.timer = null
			this.store.save(createSnapshot())
		}, this.debounceMs)
		this.timer.unref?.()
	}

	flush(createSnapshot: StateSnapshotFactory) {
		this.cancelPending()
		this.store.save(createSnapshot())
	}

	private cancelPending() {
		if (!this.timer) {
			return
		}
		clearTimeout(this.timer)
		this.timer = null
	}
}
