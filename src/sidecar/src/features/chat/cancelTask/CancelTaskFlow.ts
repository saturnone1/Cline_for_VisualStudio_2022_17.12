import type { TaskLifecycleStatus } from "../../../domain/task/TaskLifecycle"

type Callbacks = Readonly<{
	beginCancel: () => boolean
	currentStatus: () => TaskLifecycleStatus
	advanceRunGeneration: () => void
	hookSessionId: () => string
	activeSessionId: () => string
	cancelWork: (sessionId: string) => Promise<{ succeeded: boolean; completed: readonly string[]; failures: ReadonlyArray<{ name: string; reason: string; timedOut: boolean }> }>
	clearProjection: () => void
	addCancellationMarker: () => void
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
			const status = this.callbacks.currentStatus()
			if (status === "cancelling") {
				this.callbacks.log("duplicateCancelIgnored", { status })
				return
			}
			// The run already left an active phase (idle/completed/failed), so the
			// lifecycle refuses the cancelling transition. Terminals, hooks, browsers
			// and pending approvals can still be live, and a stop request must never
			// be silently dropped -- otherwise the button appears dead and the user
			// has to press it again.
			await this.settleInactiveTask(status)
			return
		}
		const hookSessionId = this.callbacks.hookSessionId()
		const activeSessionId = this.callbacks.activeSessionId()
		this.callbacks.updateTask()
		try {
			await this.callbacks.broadcast()
		} catch (error) {
			this.callbacks.log("cancelStateBroadcastFailed", { sessionId: activeSessionId, error: stringify(error) })
		}
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
			return
		}
		this.callbacks.advanceRunGeneration()
		this.callbacks.clearProjection()
		this.callbacks.addCancellationMarker()
		this.callbacks.updateTask()
		try {
			await this.callbacks.runHook(hookSessionId)
		} catch (error) {
			this.callbacks.log("cancelHookFailed", { sessionId: hookSessionId, error: stringify(error) })
		}
		this.callbacks.completeCancel()
		await this.callbacks.broadcast()
	}

	private async settleInactiveTask(status: TaskLifecycleStatus) {
		const activeSessionId = this.callbacks.activeSessionId()
		this.callbacks.log("cancelSettledInactiveTask", { status, sessionId: activeSessionId })
		// Only the leftover side work is stopped. No cancellation marker and no
		// projection clearing: the task already reached its own terminal state, and
		// clearProjection drops terminal asks, which would delete the completion
		// result of a task that finished normally.
		this.callbacks.advanceRunGeneration()
		const result = await this.callbacks.cancelWork(activeSessionId)
		if (!result.succeeded) this.callbacks.log("cancelFailed", { sessionId: activeSessionId, completed: result.completed, failures: result.failures })
		this.callbacks.updateTask()
		await this.callbacks.broadcast()
	}
}

function stringify(value: unknown) { return value instanceof Error ? value.message : String(value) }
