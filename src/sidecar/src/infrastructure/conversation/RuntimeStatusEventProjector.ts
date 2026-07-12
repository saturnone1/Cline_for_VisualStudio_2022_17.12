import type { AgentRuntimeEvent } from "../../domain/agent/AgentRuntimeEvent"
import { isTerminalTaskStatus } from "../../domain/task/TaskLifecycle"

type RuntimeLifecycleEvent = Extract<AgentRuntimeEvent, { type: "status" | "ended" }>

type Callbacks = Readonly<{
	shouldIgnore: (sessionId: string) => boolean
	markFirstEvent: (sessionId: string, eventType: string) => void
	activeText: () => string
	finishTask: (sessionId: string, status: string, text: string) => void
	updateTask: () => void
	broadcast: () => void
	transitionStreaming: (source: string) => void
	noteActivity: (reason: string) => void
	schedulePartial: () => void
	log: (event: string, details: Record<string, unknown>) => void
}>

export class RuntimeStatusEventProjector {
	constructor(private readonly callbacks: Callbacks) {}

	handle(event: RuntimeLifecycleEvent) {
		if (this.callbacks.shouldIgnore(event.sessionId)) return
		if (event.type === "ended") {
			this.finish(event.sessionId, event.reason || "ended")
			return
		}

		this.callbacks.markFirstEvent(event.sessionId, `status:${event.status}`)
		if (event.status === "idle") {
			this.callbacks.log("sdkStatusIdle", { sessionId: event.sessionId })
			this.finish(event.sessionId, "completed")
			return
		}
		if (isTerminalTaskStatus(event.status)) {
			this.finish(event.sessionId, event.status)
			return
		}
		this.callbacks.transitionStreaming(`sdk-status:${event.status || "unknown"}`)
		this.callbacks.noteActivity(event.status || "status")
		this.callbacks.schedulePartial()
	}

	private finish(sessionId: string, status: string) {
		this.callbacks.finishTask(sessionId, status, this.callbacks.activeText())
		this.callbacks.updateTask()
		this.callbacks.broadcast()
	}
}
