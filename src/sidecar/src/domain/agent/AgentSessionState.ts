import { TaskLifecycleMachine, type TaskLifecycleStatus } from "../task/TaskLifecycle"

export type PendingAgentInteraction = "none" | "tool_approval" | "question"

export type AgentSessionSnapshot = Readonly<{
	sessionId: string | null
	phase: TaskLifecycleStatus
	pendingInteraction: PendingAgentInteraction
}>

export class AgentSessionStateMachine {
	private readonly lifecycle = new TaskLifecycleMachine()
	private activeSessionId: string | null = null
	private pending: PendingAgentInteraction = "none"

	get snapshot(): AgentSessionSnapshot {
		return {
			sessionId: this.activeSessionId,
			phase: this.lifecycle.status,
			pendingInteraction: this.pending,
		}
	}

	initialize(phase: TaskLifecycleStatus, sessionId: string | null = null) {
		this.lifecycle.initialize(phase)
		this.activeSessionId = sessionId
		this.pending = phase === "awaiting_user" ? this.pending : "none"
	}

	bindSession(sessionId: string) {
		if (sessionId) this.activeSessionId = sessionId
	}

	transition(phase: TaskLifecycleStatus) {
		const accepted = this.lifecycle.transition(phase)
		if (accepted && phase !== "awaiting_user") this.pending = "none"
		return accepted
	}

	waitFor(interaction: Exclude<PendingAgentInteraction, "none">) {
		if (this.lifecycle.status !== "awaiting_user") return false
		this.pending = interaction
		return true
	}

	reset() {
		this.lifecycle.reset()
		this.activeSessionId = null
		this.pending = "none"
	}
}
