export type InactivityWatchdogOptions = Readonly<{
	inactivityMs: number
	graceChecks?: number
	onWaiting?: (quietForMs: number, check: number) => void
	onTimeout: (quietForMs: number) => void
}>

export class InactivityWatchdog {
	private timer: NodeJS.Timeout | undefined
	private lastActivityAt = Date.now()
	private checks = 0
	private disposed = false

	constructor(private readonly options: InactivityWatchdogOptions) {}

	start() {
		this.schedule()
		return this
	}

	touch() {
		if (this.disposed) return
		this.lastActivityAt = Date.now()
		this.checks = 0
		this.schedule()
	}

	dispose() {
		this.disposed = true
		if (this.timer) clearTimeout(this.timer)
		this.timer = undefined
	}

	private schedule() {
		if (this.timer) clearTimeout(this.timer)
		if (this.disposed) return
		const inactivityMs = Math.max(1, Math.floor(this.options.inactivityMs))
		this.timer = setTimeout(() => this.inspect(), inactivityMs)
		this.timer.unref?.()
	}

	private inspect() {
		if (this.disposed) return
		const inactivityMs = Math.max(1, Math.floor(this.options.inactivityMs))
		const quietForMs = Date.now() - this.lastActivityAt
		if (quietForMs < inactivityMs) {
			this.schedule()
			return
		}
		const graceChecks = Math.max(0, Math.floor(this.options.graceChecks ?? 1))
		if (this.checks < graceChecks) {
			this.checks++
			this.options.onWaiting?.(quietForMs, this.checks)
			this.schedule()
			return
		}
		this.dispose()
		this.options.onTimeout(quietForMs)
	}
}
