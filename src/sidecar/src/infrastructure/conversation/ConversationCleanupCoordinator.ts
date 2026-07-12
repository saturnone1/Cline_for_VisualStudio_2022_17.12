import type { InteractionLoggerPort } from "../../application/ports/InteractionLoggerPort"
import type { ConversationProjectionState } from "../../features/conversation/ConversationProjectionState"
import type { RuntimeMonitoringCoordinator } from "../../features/runtime/RuntimeMonitoringCoordinator"
import type { ConversationMessageStore } from "./ConversationMessageStore"
import type { ConversationRuntimeProjector } from "./ConversationRuntimeProjector"
import type { FoldedProgressProjector } from "./FoldedProgressProjector"
import type { PartialTextProjector } from "./PartialTextProjector"

type ConversationCleanupDependencies = {
	projection: ConversationProjectionState
	messages: ConversationMessageStore
	partial: PartialTextProjector
	folded: FoldedProgressProjector
	runtime: ConversationRuntimeProjector
	monitoring: RuntimeMonitoringCoordinator
	terminalActive: () => boolean
	stopTerminal: () => void
	hasPendingApproval: () => boolean
	hasPendingQuestion: () => boolean
	clearApproval: (reason: string) => void
	clearQuestion: () => void
	logger: InteractionLoggerPort
}

export class ConversationCleanupCoordinator {
	constructor(private readonly dependencies: ConversationCleanupDependencies) {}

	finishProgress() {
		this.dependencies.partial.finalize()
		this.dependencies.runtime.finishToolActivity()
		this.dependencies.folded.finish()
	}

	prepareAssistant() {
		this.dependencies.monitoring.clearTaskActivity()
		this.dependencies.monitoring.clearPartialIdle()
		this.finishProgress()
	}

	clearProjection() {
		this.dependencies.monitoring.clearAll()
		this.finishProgress()
	}

	finalizeOpenPartials() {
		this.dependencies.monitoring.clearPartialState()
		this.dependencies.stopTerminal()
		this.dependencies.messages.finalizeOpenPartials()
		this.dependencies.projection.activePartialTextTs = null
		this.dependencies.projection.finishProgressMessage()
	}

	clearLiveInteraction(reason: string) {
		const hadState =
			this.dependencies.hasPendingApproval() ||
			this.dependencies.hasPendingQuestion() ||
			this.dependencies.projection.hasActiveInteraction ||
			this.dependencies.terminalActive()

		this.dependencies.monitoring.clearAll()
		this.dependencies.stopTerminal()
		this.dependencies.clearApproval(`Cleared by ${reason}.`)
		this.dependencies.clearQuestion()
		this.dependencies.projection.clearActiveInteraction()
		if (hadState) this.dependencies.logger.log("sidecar", "clearedLiveInteractionState", { reason })
	}
}
