import { TaskLifecycleMachine, type TaskLifecycleStatus } from "../../domain/task/TaskLifecycle"

export type TaskTransition = Readonly<{
	accepted: boolean
	previous: TaskLifecycleStatus
	current: TaskLifecycleStatus
	source: string
}>

export class TaskLifecycleUseCase {
	private readonly machine = new TaskLifecycleMachine()

	initialize(status: TaskLifecycleStatus) {
		this.machine.initialize(status)
	}

	transition(status: TaskLifecycleStatus, source: string): TaskTransition {
		const previous = this.machine.status
		const accepted = this.machine.transition(status)
		return { accepted, previous, current: this.machine.status, source }
	}

	reset(source: string): TaskTransition {
		const previous = this.machine.status
		this.machine.reset()
		return { accepted: true, previous, current: this.machine.status, source }
	}

	get status() {
		return this.machine.status
	}
}
