import type { AgentEnginePort } from "../../../application/ports/AgentEnginePort"

type Callbacks = Readonly<{
	transition: (status: "cancelling", source: string) => void
	advanceRunGeneration: () => void
	currentSessionId: () => string
	markClosing: (sessionId: string) => void
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
		this.callbacks.transition("cancelling", "clear-task")
		this.callbacks.advanceRunGeneration()
		const engine = this.engine()
		const sessionId = this.callbacks.currentSessionId()
		if (engine && sessionId) {
			this.callbacks.markClosing(sessionId)
			await engine.abort({ sessionId }).catch((error) => this.callbacks.log("clearTaskAbortFailed", { sessionId, error: stringify(error) }))
			await engine.stop({ sessionId }).catch((error) => this.callbacks.log("clearTaskStopFailed", { sessionId, error: stringify(error) }))
		}
		this.callbacks.rememberSnapshot(sessionId)
		this.callbacks.clearProjection()
		this.callbacks.clearInteractions()
		this.callbacks.clearTaskState()
		this.callbacks.resetLifecycle("clear-task-complete")
		this.callbacks.persist()
		await this.callbacks.broadcast()
		engine?.markSessionInactive(sessionId)
	}
}

function stringify(value: unknown) { return value instanceof Error ? value.message : String(value) }
