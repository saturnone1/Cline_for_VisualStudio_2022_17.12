import type { AgentEnginePort } from "../../../application/ports/AgentEnginePort"
import type { TaskLifecycleStatus } from "../../../domain/task/TaskLifecycle"

type Callbacks = Readonly<{
	transition: (status: "cancelling", source: string) => void
	currentStatus: () => TaskLifecycleStatus
	advanceRunGeneration: () => void
	currentSessionId: () => string
	isClosing: (sessionId: string) => boolean
	markClosing: (sessionId: string, closing?: boolean) => void
	cancelWork: (sessionId: string) => Promise<{ succeeded: boolean; completed: readonly string[]; failures: ReadonlyArray<{ name: string; reason: string; timedOut: boolean }> }>
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
		const engine = this.engine()
		const sessionId = this.callbacks.currentSessionId()
		const requiresCancellation = previousStatus === "starting" || previousStatus === "streaming" || previousStatus === "awaiting_user" || previousStatus === "cancelling" || this.callbacks.isClosing(sessionId)
		if (requiresCancellation) this.callbacks.transition("cancelling", "clear-task")
		this.callbacks.advanceRunGeneration()
		if (sessionId && requiresCancellation) this.callbacks.markClosing(sessionId)
		this.callbacks.rememberSnapshot(sessionId)
		if (sessionId) engine?.markSessionInactive(sessionId)
		if (sessionId && requiresCancellation) {
			this.callbacks.persist()
			try {
				await this.callbacks.broadcast()
			} catch (error) {
				this.callbacks.log("clearTaskCancellingBroadcastFailed", { sessionId, error: stringify(error) })
			}
			await this.stopActiveSession(sessionId)
		}
		this.callbacks.clearProjection()
		this.callbacks.clearInteractions()
		this.callbacks.clearTaskState()
		this.callbacks.resetLifecycle("clear-task-complete")
		this.callbacks.persist()
		await this.callbacks.broadcast()
	}

	private async stopActiveSession(sessionId: string) {
		try {
			const cancellation = await this.callbacks.cancelWork(sessionId)
			if (!cancellation.succeeded) {
				this.callbacks.log("clearTaskCancellationIncomplete", { sessionId, completed: cancellation.completed, failures: cancellation.failures })
			}
		} catch (error) {
			this.callbacks.log("clearTaskCancellationFailed", { sessionId, error: stringify(error) })
		}
	}
}

function stringify(value: unknown) { return value instanceof Error ? value.message : String(value) }
