import type { TaskLifecycleUseCase } from "../../application/useCases/TaskLifecycleUseCase"
import type { InteractionLoggerPort } from "../../application/ports/InteractionLoggerPort"
import type { PendingAgentInteraction } from "../../domain/agent/AgentSessionState"
import type { TaskLifecycleStatus } from "../../domain/task/TaskLifecycle"

type TaskRecord = Record<string, unknown>

type TaskSessionDependencies = {
	lifecycle: TaskLifecycleUseCase
	logger: InteractionLoggerPort
	activeSessionId: () => string
	currentTask: () => TaskRecord | null
	writeCurrentTask: (task: TaskRecord) => void
	isDeleted: (sessionId: string) => boolean
	rebindHistory: (previousTaskId: string, sessionId: string) => void
	rebindSnapshot: (previousTaskId: string, sessionId: string) => void
	rebindLatency: (previousTaskId: string, sessionId: string) => void
	writeLifecycleStatus: (status: TaskLifecycleStatus) => void
}

export class TaskSessionCoordinator {
	private readonly closingSessionIds = new Set<string>()

	constructor(private readonly dependencies: TaskSessionDependencies) {}

	get status() { return this.dependencies.lifecycle.status }

	initialize(status: TaskLifecycleStatus) {
		this.dependencies.lifecycle.initialize(status)
		this.dependencies.writeLifecycleStatus(this.dependencies.lifecycle.status)
	}

	markClosing(sessionId: string, closing = true) {
		if (!sessionId) return
		if (closing) this.closingSessionIds.add(sessionId)
		else this.closingSessionIds.delete(sessionId)
	}

	prepareActivation(sessionId: string) { this.markClosing(sessionId, false) }

	shouldIgnoreEvent(sessionId: string) {
		if (!sessionId) return false
		if (this.closingSessionIds.has(sessionId)) return true
		const currentTask = this.dependencies.currentTask()
		if (!currentTask) return true
		const activeSessionId = this.dependencies.activeSessionId()
		if (activeSessionId) return sessionId !== activeSessionId
		const currentTaskId = String(currentTask.id || "")
		return Boolean(currentTaskId && sessionId !== currentTaskId)
	}

	isCurrentResult(sessionId: string) {
		if (!sessionId || this.closingSessionIds.has(sessionId) || this.dependencies.isDeleted(sessionId)) return false
		const currentTaskId = String(this.dependencies.currentTask()?.id || "")
		return Boolean(currentTaskId && currentTaskId === sessionId)
	}

	bindSession(sessionId: string) {
		this.dependencies.lifecycle.bindSession(sessionId)
		const currentTask = this.dependencies.currentTask()
		if (!sessionId || !currentTask) return
		const currentTaskId = String(currentTask.id || "")
		if (!currentTaskId || currentTaskId === sessionId) return

		this.dependencies.rebindSnapshot(currentTaskId, sessionId)
		this.dependencies.writeCurrentTask({ ...currentTask, id: sessionId })
		this.dependencies.rebindHistory(currentTaskId, sessionId)
		this.dependencies.rebindLatency(currentTaskId, sessionId)
		this.dependencies.logger.log("sidecar", "taskSessionIdRebound", { previousTaskId: currentTaskId, sessionId })
	}

	waitFor(interaction: Exclude<PendingAgentInteraction, "none">) {
		return this.dependencies.lifecycle.waitFor(interaction)
	}

	transition(status: TaskLifecycleStatus, source: string) {
		const transition = this.dependencies.lifecycle.transition(status, source)
		if (!transition.accepted) {
			this.dependencies.logger.log("sidecar", "taskLifecycleTransitionRejected", transition)
			return false
		}
		this.dependencies.writeLifecycleStatus(transition.current)
		if (transition.previous !== transition.current) {
			this.dependencies.logger.log("sidecar", "taskLifecycleTransition", transition)
		}
		return true
	}

	reset(source: string) {
		const transition = this.dependencies.lifecycle.reset(source)
		this.dependencies.writeLifecycleStatus(transition.current)
		return transition
	}
}
