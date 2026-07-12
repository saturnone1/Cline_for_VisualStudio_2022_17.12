import type { AgentEvent } from "../../domain/agent/AgentRuntimeEvent"

export type AgentEventProjection = Readonly<{ handled: boolean; broadcast: boolean }>

type Callbacks = Readonly<{
	bindSession: (sessionId: string) => void
	projectText: (event: AgentEvent) => AgentEventProjection
	projectTool: (event: AgentEvent) => AgentEventProjection
	projectLifecycle: (event: AgentEvent) => AgentEventProjection
	updateTask: () => void
	broadcast: () => void
}>

export class AgentEventDispatcher {
	constructor(private readonly callbacks: Callbacks) {}

	handle(event: AgentEvent, sessionId = event.sessionId) {
		if (sessionId) this.callbacks.bindSession(sessionId)
		const projection = this.firstHandled(event)
		this.callbacks.updateTask()
		if (!projection || projection.broadcast) this.callbacks.broadcast()
	}

	private firstHandled(event: AgentEvent) {
		for (const project of [this.callbacks.projectText, this.callbacks.projectTool, this.callbacks.projectLifecycle]) {
			const result = project(event)
			if (result.handled) return result
		}
		return undefined
	}
}
