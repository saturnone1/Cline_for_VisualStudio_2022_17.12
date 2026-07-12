import { isTerminalTaskStatus } from "../../domain/task/TaskLifecycle"
import type { PartialStateScheduler } from "./PartialStateScheduler"
import type { SendLatencyMonitor } from "./SendLatencyMonitor"
import type { TaskActivityMonitor } from "./TaskActivityMonitor"

type RuntimeMonitoringDependencies = {
	taskActivity: () => TaskActivityMonitor
	optionalTaskActivity: () => TaskActivityMonitor | null
	partialState: () => PartialStateScheduler
	optionalPartialState: () => PartialStateScheduler | null
	sendLatency: () => SendLatencyMonitor
	hasCompletionResult: () => boolean
}

export class RuntimeMonitoringCoordinator {
	constructor(private readonly dependencies: RuntimeMonitoringDependencies) {}

	startLatency(requestId: string, kind: "newTask" | "askResponse", sessionId: string, textLength: number) {
		this.dependencies.sendLatency().start(requestId, kind, sessionId, textLength)
	}

	markSdkSend(sessionId: string) { this.dependencies.sendLatency().markSdkSend(sessionId) }
	markFirstSdkEvent(sessionId: string, eventType: string) { this.dependencies.sendLatency().markFirstSdkEvent(sessionId, eventType) }
	markFirstAssistant(sessionId: string, textLength: number) { this.dependencies.sendLatency().markFirstAssistant(sessionId, textLength) }
	markError(sessionId: string, error: unknown) { this.dependencies.sendLatency().markError(sessionId, error) }
	rebindLatency(previousSessionId: string, nextSessionId: string) { this.dependencies.sendLatency().rebind(previousSessionId, nextSessionId) }

	schedulePartialIdle() { this.dependencies.partialState().scheduleIdle() }
	clearPartialIdle() { this.dependencies.optionalPartialState()?.clearIdle() }
	clearPartialBroadcast() { this.dependencies.optionalPartialState()?.clearBroadcast() }
	broadcastPartialNow() { this.dependencies.partialState().broadcastNow() }
	schedulePartialBroadcast() { this.dependencies.partialState().scheduleBroadcast() }

	noteActivity(reason: string) {
		const terminal = this.dependencies.hasCompletionResult() || isTerminalTaskStatus(reason) || TERMINAL_ACTIVITY_REASONS.has(reason)
		this.dependencies.taskActivity().note(reason, terminal)
		if (terminal) this.clearPartialState()
	}

	noteQuietActivity(reason: string) { this.dependencies.taskActivity().quiet(reason) }
	clearTaskActivity() { this.dependencies.optionalTaskActivity()?.clear() }

	clearPartialState() {
		this.clearPartialIdle()
		this.clearPartialBroadcast()
	}

	clearAll() {
		this.clearPartialState()
		this.clearTaskActivity()
	}
}

const TERMINAL_ACTIVITY_REASONS = new Set(["done", "ended", "run-finished"])
