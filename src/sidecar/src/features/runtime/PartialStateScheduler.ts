import type { InteractionLoggerPort } from "../../application/ports/InteractionLoggerPort"

export type ActivePartialSnapshot = Readonly<{ textLength: number }>

export class PartialStateScheduler {
	private idleTimer: NodeJS.Timeout | null = null
	private broadcastTimer: NodeJS.Timeout | null = null
	private lastBroadcastAt = 0

	constructor(
		private readonly logger: InteractionLoggerPort,
		private readonly hasSubscribers: () => boolean,
		private readonly getActivePartial: () => ActivePartialSnapshot | null,
		private readonly onIdle: () => void,
		private readonly broadcast: () => void,
		private readonly idleTimeoutMs: number,
		private readonly broadcastIntervalMs: number,
	) {}

	scheduleIdle() {
		this.clearIdle()
		this.idleTimer = setTimeout(() => {
			const partial = this.getActivePartial()
			if (!partial || partial.textLength === 0) return
			this.logger.log("sidecar", "partialIdleNotice", { timeoutMs: this.idleTimeoutMs, textLength: partial.textLength })
			this.onIdle()
		}, this.idleTimeoutMs)
	}

	clearIdle() { if (this.idleTimer) clearTimeout(this.idleTimer); this.idleTimer = null }
	clearBroadcast() { if (this.broadcastTimer) clearTimeout(this.broadcastTimer); this.broadcastTimer = null }

	broadcastNow() {
		if (!this.hasSubscribers()) return
		this.clearBroadcast()
		this.lastBroadcastAt = Date.now()
		this.broadcast()
	}

	scheduleBroadcast() {
		if (!this.hasSubscribers() || this.broadcastTimer) return
		const elapsed = Date.now() - this.lastBroadcastAt
		if (elapsed >= this.broadcastIntervalMs) { this.lastBroadcastAt = Date.now(); this.broadcast(); return }
		this.broadcastTimer = setTimeout(() => { this.broadcastTimer = null; this.lastBroadcastAt = Date.now(); this.broadcast() }, this.broadcastIntervalMs - elapsed)
	}

	dispose() { this.clearIdle(); this.clearBroadcast() }
}
