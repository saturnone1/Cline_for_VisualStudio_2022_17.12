type Callbacks = Readonly<{
	beginCancel: () => boolean
	currentStatus: () => string
	advanceRunGeneration: () => void
	hookSessionId: () => string
	activeSessionId: () => string
	cancelRemote: (sessionId: string) => Promise<void>
	clearProjection: () => void
	addInfo: (text: string) => void
	updateTask: () => void
	runHook: (sessionId: string) => Promise<unknown>
	completeCancel: () => void
	broadcast: () => Promise<void>
	log: (event: string, details: Record<string, unknown>) => void
}>

export class CancelTaskFlow {
	constructor(private readonly callbacks: Callbacks) {}

	async execute() {
		if (!this.callbacks.beginCancel()) {
			this.callbacks.log("duplicateCancelIgnored", { status: this.callbacks.currentStatus() })
			return
		}
		this.callbacks.advanceRunGeneration()
		const hookSessionId = this.callbacks.hookSessionId()
		const activeSessionId = this.callbacks.activeSessionId()
		if (activeSessionId) await this.callbacks.cancelRemote(activeSessionId).catch((error) => this.callbacks.log("cancelAbortFailed", { sessionId: activeSessionId, error: stringify(error) }))
		this.callbacks.clearProjection()
		this.callbacks.addInfo("현재 진행 중인 요청을 취소했습니다. 이전 대화와 세션은 유지됩니다.")
		this.callbacks.updateTask()
		await this.callbacks.runHook(hookSessionId)
		this.callbacks.completeCancel()
		await this.callbacks.broadcast()
	}
}

function stringify(value: unknown) { return value instanceof Error ? value.message : String(value) }
