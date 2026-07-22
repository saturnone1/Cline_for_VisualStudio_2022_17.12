import type { TaskLifecycleStatus } from "../../../domain/task/TaskLifecycle"

type Callbacks = Readonly<{
	beginCancel: () => boolean
	currentStatus: () => TaskLifecycleStatus
	advanceRunGeneration: () => void
	hookSessionId: () => string
	activeSessionId: () => string
	cancelWork: (sessionId: string) => Promise<{ succeeded: boolean; failures: ReadonlyArray<{ name: string; reason: string; timedOut: boolean }> }>
	clearProjection: () => void
	addInfo: (text: string) => void
	updateTask: () => void
	runHook: (sessionId: string) => Promise<unknown>
	completeCancel: () => void
	restoreLifecycle: (status: TaskLifecycleStatus) => void
	addError: (text: string) => void
	broadcast: () => Promise<void>
	log: (event: string, details: Record<string, unknown>) => void
}>

export class CancelTaskFlow {
	constructor(private readonly callbacks: Callbacks) {}

	async execute() {
		const previousStatus = this.callbacks.currentStatus()
		if (!this.callbacks.beginCancel()) {
			this.callbacks.log("duplicateCancelIgnored", { status: this.callbacks.currentStatus() })
			return
		}
		const hookSessionId = this.callbacks.hookSessionId()
		const activeSessionId = this.callbacks.activeSessionId()
		const result = await this.callbacks.cancelWork(activeSessionId)
		if (!result.succeeded) {
			const details = result.failures.map((failure) => `${failure.name}: ${failure.reason}`).join("\n")
			this.callbacks.log("cancelFailed", { sessionId: activeSessionId, failures: result.failures })
			this.callbacks.addError(`요청을 완전히 취소하지 못했습니다. 아직 실행 중인 작업이 있을 수 있습니다.\n\n${details}`)
			this.callbacks.updateTask()
			this.callbacks.restoreLifecycle(previousStatus)
			await this.callbacks.broadcast()
			throw new Error("One or more task cancellation operations failed.")
		}
		this.callbacks.advanceRunGeneration()
		this.callbacks.clearProjection()
		this.callbacks.addInfo("현재 진행 중인 요청을 취소했습니다. 이전 대화와 세션은 유지됩니다.")
		this.callbacks.updateTask()
		await this.callbacks.runHook(hookSessionId)
		this.callbacks.completeCancel()
		await this.callbacks.broadcast()
	}
}
