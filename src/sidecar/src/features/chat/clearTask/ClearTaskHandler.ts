import type { AgentEnginePort } from "../../../application/ports/AgentEnginePort"
import type { TaskLifecycleStatus } from "../../../domain/task/TaskLifecycle"

type Callbacks = Readonly<{
	transition: (status: "cancelling", source: string) => void
	currentStatus: () => TaskLifecycleStatus
	advanceRunGeneration: () => void
	currentSessionId: () => string
	markClosing: (sessionId: string, closing?: boolean) => void
	cancelWork: (sessionId: string) => Promise<{ succeeded: boolean; failures: ReadonlyArray<{ name: string; reason: string; timedOut: boolean }> }>
	restoreLifecycle: (status: TaskLifecycleStatus) => void
	addError: (text: string) => void
	rememberSnapshot: (sessionId: string) => void
	clearProjection: () => void
	clearInteractions: () => void
	clearTaskState: () => void
	resetLifecycle: (source: string) => void
	persist: () => void
	broadcast: () => Promise<void>
	log: (event: string, details: Record<string, unknown>) => void
}>

export class ClearTaskHandler {
	constructor(private readonly engine: () => AgentEnginePort | null, private readonly callbacks: Callbacks) {}

	async execute() {
		const previousStatus = this.callbacks.currentStatus()
		const requiresCancellation = previousStatus !== "idle" && previousStatus !== "completed"
		if (requiresCancellation) this.callbacks.transition("cancelling", "clear-task")
		const engine = this.engine()
		const sessionId = this.callbacks.currentSessionId()
		if (sessionId && requiresCancellation) {
			this.callbacks.markClosing(sessionId)
			const cancellation = await this.callbacks.cancelWork(sessionId)
			if (!cancellation.succeeded) {
				this.callbacks.markClosing(sessionId, false)
				this.callbacks.restoreLifecycle(previousStatus)
				const details = cancellation.failures.map((failure) => `${failure.name}: ${failure.reason}`).join("\n")
				this.callbacks.addError(`세션을 종료하지 못해 대화 화면을 유지합니다.\n\n${details}`)
				await this.callbacks.broadcast()
				throw new Error("The active task could not be cancelled before leaving the session.")
			}
			if (engine) {
				try {
					await engine.stop({ sessionId })
				} catch (error) {
					this.callbacks.markClosing(sessionId, false)
					this.callbacks.restoreLifecycle(previousStatus)
					this.callbacks.addError(`세션 런타임을 종료하지 못해 대화 화면을 유지합니다.\n\n${stringify(error)}`)
					await this.callbacks.broadcast()
					throw error
				}
			}
		}
		this.callbacks.advanceRunGeneration()
		this.callbacks.rememberSnapshot(sessionId)
		this.callbacks.clearProjection()
		this.callbacks.clearInteractions()
		this.callbacks.clearTaskState()
		this.callbacks.resetLifecycle("clear-task-complete")
		this.callbacks.persist()
		await this.callbacks.broadcast()
		if (sessionId) engine?.markSessionInactive(sessionId)
	}
}

function stringify(value: unknown) { return value instanceof Error ? value.message : String(value) }
