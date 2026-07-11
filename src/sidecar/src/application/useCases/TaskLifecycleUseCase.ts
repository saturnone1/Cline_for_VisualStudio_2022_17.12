import type { TaskLifecycleStatus } from "../../domain/task/TaskLifecycle"
import { AgentSessionStateMachine, type PendingAgentInteraction } from "../../domain/agent/AgentSessionState"

export type TaskTransition = Readonly<{
	accepted: boolean
	previous: TaskLifecycleStatus
	current: TaskLifecycleStatus
	source: string
}>

export class TaskLifecycleUseCase {
	private readonly session = new AgentSessionStateMachine()

	initialize(status: TaskLifecycleStatus) {
		this.session.initialize(status)
	}

	bindSession(sessionId: string) { this.session.bindSession(sessionId) }
	waitFor(interaction: Exclude<PendingAgentInteraction, "none">) { return this.session.waitFor(interaction) }

	transition(status: TaskLifecycleStatus, source: string): TaskTransition {
		const previous = this.session.snapshot.phase
		const accepted = this.session.transition(status)
		return { accepted, previous, current: this.session.snapshot.phase, source }
	}

	reset(source: string): TaskTransition {
		const previous = this.session.snapshot.phase
		this.session.reset()
		return { accepted: true, previous, current: this.session.snapshot.phase, source }
	}

	get status() {
		return this.session.snapshot.phase
	}

	get snapshot() { return this.session.snapshot }
}
