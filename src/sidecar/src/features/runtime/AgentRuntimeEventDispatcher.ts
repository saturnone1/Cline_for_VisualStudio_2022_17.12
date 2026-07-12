import type { AgentEvent, AgentRuntimeEvent, WorkspaceChange } from "../../domain/agent/AgentRuntimeEvent"

type ChunkEvent = Extract<AgentRuntimeEvent, { type: "chunk" }>
type SnapshotEvent = Extract<AgentRuntimeEvent, { type: "session_snapshot" }>
type AuxiliaryEvent = Extract<AgentRuntimeEvent, { type: "team_progress" | "hook" | "pending_prompts" | "pending_prompt_submitted" }>
type LifecycleEvent = Extract<AgentRuntimeEvent, { type: "status" | "ended" }>

type Callbacks = Readonly<{
	transitionStreaming: (source: string) => void
	shouldIgnore: (sessionId: string) => boolean
	markFirstEvent: (sessionId: string, eventType: string) => void
	projectAgent: (event: AgentEvent, sessionId: string) => void
	trackWorkspaceChange: (change: WorkspaceChange) => void
	projectChunk: (event: ChunkEvent) => void
	projectSnapshot: (event: SnapshotEvent) => void
	projectAuxiliary: (event: AuxiliaryEvent) => void
	projectLifecycle: (event: LifecycleEvent) => void
	log: (event: string, details: Record<string, unknown>) => void
	activeSessionId: () => string
	currentTaskId: () => string
}>

export class AgentRuntimeEventDispatcher {
	constructor(private readonly callbacks: Callbacks) {}

	handle(event: AgentRuntimeEvent) {
		const eventType = event.type === "unknown" ? event.originalType : event.type
		if (eventType && eventType !== "vscline_file_changed" && eventType !== "status" && eventType !== "ended") this.callbacks.transitionStreaming(`sdk:${eventType}`)

		if (event.type === "agent_event") {
			if (this.ignore(event.sessionId, "ignoredSdkAgentEvent")) return
			this.callbacks.markFirstEvent(event.sessionId, event.event.type)
			this.callbacks.projectAgent(event.event, event.sessionId)
			return
		}
		if (event.type === "vscline_file_changed") {
			this.callbacks.trackWorkspaceChange(event.change)
			return
		}
		if (event.type === "chunk") {
			if (this.ignore(event.sessionId)) return
			this.callbacks.markFirstEvent(event.sessionId, eventType)
			this.callbacks.projectChunk(event)
			return
		}
		if (event.type === "session_snapshot") {
			if (this.ignore(event.sessionId)) return
			this.callbacks.markFirstEvent(event.sessionId, eventType)
			this.callbacks.projectSnapshot(event)
			return
		}
		if (event.type === "team_progress" || event.type === "hook" || event.type === "pending_prompts" || event.type === "pending_prompt_submitted") {
			if (this.ignore(event.sessionId)) return
			this.callbacks.projectAuxiliary(event)
			return
		}
		if (event.type === "status" || event.type === "ended") this.callbacks.projectLifecycle(event)
	}

	private ignore(sessionId: string, logEvent = "") {
		if (!this.callbacks.shouldIgnore(sessionId)) return false
		if (logEvent) this.callbacks.log(logEvent, { sessionId, activeSessionId: this.callbacks.activeSessionId(), currentTaskId: this.callbacks.currentTaskId() })
		return true
	}
}
