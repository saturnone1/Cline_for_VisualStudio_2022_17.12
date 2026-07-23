import type { TaskLifecycleStatus } from "../../../domain/task/TaskLifecycle"

type Callbacks = Readonly<{
	beginCancel: () => boolean
	currentStatus: () => TaskLifecycleStatus
	advanceRunGeneration: () => void
	hookSessionId: () => string
	activeSessionId: () => string
	cancelWork: (sessionId: string) => Promise<{ succeeded: boolean; completed: readonly string[]; failures: ReadonlyArray<{ name: string; reason: string; timedOut: boolean }> }>
	clearProjection: () => void
	addInfo: (text: string) => void
	updateTask: () => void
	runHook: (sessionId: string) => Promise<unknown>
	completeCancel: () => void
	failCancellation: () => void
	quarantineSession: (sessionId: string) => void
	addError: (text: string) => void
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
		const hookSessionId = this.callbacks.hookSessionId()
		const activeSessionId = this.callbacks.activeSessionId()
		const result = await this.callbacks.cancelWork(activeSessionId)
		if (!result.succeeded) {
			const details = result.failures.map((failure) => `${failure.name}: ${failure.reason}`).join("\n")
			this.callbacks.log("cancelFailed", { sessionId: activeSessionId, completed: result.completed, failures: result.failures })
			this.callbacks.addError(`요청을 완전히 취소하지 못했습니다. 아직 실행 중인 작업이 있을 수 있습니다.\n\n${details}`)
			this.callbacks.updateTask()
			// Cancellation is not transactional. Once any participant has been asked to
			// stop, the previous run can no longer be trusted to remain resumable.
			this.callbacks.advanceRunGeneration()
			this.callbacks.quarantineSession(activeSessionId)
			this.callbacks.failCancellation()
			await this.callbacks.broadcast()
			throw new Error("One or more task cancellation operations failed.")
		}
		this.callbacks.advanceRunGeneration()
		this.callbacks.clearProjection()
		this.callbacks.addInfo("현재 진행 중인 요청을 취소했습니다. 이전 대화와 세션은 유지됩니다.")
		this.callbacks.updateTask()
		try {
			await this.callbacks.runHook(hookSessionId)
		} catch (error) {
			this.callbacks.log("cancelHookFailed", { sessionId: hookSessionId, error: stringify(error) })
		}
		this.callbacks.completeCancel()
		await this.callbacks.broadcast()
	}
}

function stringify(value: unknown) { return value instanceof Error ? value.message : String(value) }
