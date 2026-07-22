import type { InteractionLoggerPort } from "../../application/ports/InteractionLoggerPort"

export class TaskActivityMonitor {
	private noticeTimer: NodeJS.Timeout | null = null
	private timeoutTimer: NodeJS.Timeout | null = null
	private lastActivityAt = 0
	private lastReason = ""

	constructor(
		private readonly logger: InteractionLoggerPort,
		private readonly isTaskActive: () => boolean,
		private readonly hasActivePartial: () => boolean,
		private readonly onWaiting: (idleForMs: number, reason: string) => void,
		private readonly onLongRunning: () => void,
		private readonly noticeMs: number,
		private readonly timeoutMs: number,
	) {}

	get reason() { return this.lastReason }

	note(reason: string, terminal = false) {
		if (!this.isTaskActive()) return
		this.lastActivityAt = Date.now()
		this.lastReason = reason
		this.logger.log("sidecar", "taskActivity", { reason })
		if (terminal) { this.clear(); return }
		this.schedule()
	}

	quiet(reason: string) { if (this.isTaskActive()) { this.lastActivityAt = Date.now(); this.lastReason = reason } }

	clear() {
		if (this.noticeTimer) clearTimeout(this.noticeTimer)
		if (this.timeoutTimer) clearTimeout(this.timeoutTimer)
		this.noticeTimer = null
		this.timeoutTimer = null
	}

	dispose() { this.clear() }

	private schedule() {
		this.clear()
		if (!this.isTaskActive()) return
		if (this.noticeMs > 0 && this.noticeMs < this.timeoutMs) this.noticeTimer = setTimeout(() => this.notice(), this.noticeMs)
		this.timeoutTimer = setTimeout(() => this.timeout(), this.timeoutMs)
	}

	private notice() {
		if (!this.isTaskActive() || this.hasActivePartial()) return
		const idleForMs = Date.now() - this.lastActivityAt
		if (idleForMs < this.noticeMs - 1000) return
		this.logger.log("sidecar", "taskIdleNotice", { noticeMs: this.noticeMs, idleForMs, reason: this.lastReason })
		this.onWaiting(idleForMs, this.lastReason)
	}

	private timeout() {
		if (!this.isTaskActive()) return
		const idleForMs = Date.now() - this.lastActivityAt
		if (idleForMs < this.timeoutMs - 1000) { this.schedule(); return }
		this.logger.log("sidecar", "taskIdleLongRunning", { timeoutMs: this.timeoutMs, idleForMs, reason: this.lastReason })
		this.onLongRunning()
	}
}
