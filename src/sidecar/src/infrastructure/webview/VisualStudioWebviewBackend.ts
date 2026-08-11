import type { AskQuestionResult, ToolApprovalResult } from "../../application/ports/AgentInteraction"
import type { WebviewApplicationPort } from "../../application/ports/WebviewApplicationPort"
import type { WebviewTransportPort } from "../../application/ports/WebviewTransportPort"
import type { HostProviderPort } from "../../application/ports/HostProviderPort"
import type { InteractionLoggerPort } from "../../application/ports/InteractionLoggerPort"
import type { StatePersistenceUseCase } from "../../application/useCases/StatePersistenceUseCase"
import type { TaskLifecycleUseCase } from "../../application/useCases/TaskLifecycleUseCase"
import type { WebviewEnvelope } from "../../application/dto/WebviewRpc"
import type { AgentRuntimeEvent, ApprovalRequestedEvent } from "../../domain/agent/AgentRuntimeEvent"
import { WebviewBackendComposition } from "./WebviewBackendComposition"
import type { RuntimeWebviewFeatures } from "./WebviewFeatureRegistry"

export class VisualStudioWebviewBackend implements WebviewApplicationPort {
	private readonly composition: WebviewBackendComposition

	constructor(
		host: HostProviderPort,
		transport: WebviewTransportPort,
		logger: InteractionLoggerPort,
		stateStore: StatePersistenceUseCase,
		taskLifecycle: TaskLifecycleUseCase,
	) {
		this.composition = new WebviewBackendComposition(host, transport, logger, stateStore, taskLifecycle)
	}

	configureFeatures(features: RuntimeWebviewFeatures) { this.composition.configureFeatures(features) }
	getBrowserSettings() { return this.composition.getBrowserSettings() }
	getAutoApprovalSettings() { return this.composition.getAutoApprovalSettings() }
	getCommandExecutionSettings() { return this.composition.getCommandExecutionSettings() }

	serializeState() { return this.composition.serializeState() }
	publishChangeTranscript(text: string) { return this.composition.publishChangeTranscript(text) }
	updateTerminalActivity(text: string) { this.composition.updateTerminalActivity(text) }
	hasActiveAgentRun() { return this.composition.hasActiveAgentRun() }
	hasActivePartialText() { return this.composition.hasActivePartialText() }
	handleTaskIdleLongRunning() { this.composition.handleTaskIdleLongRunning() }
	handleTaskIdleWaiting(idleForMs: number, reason: string) { this.composition.handleTaskIdleWaiting(idleForMs, reason) }
	hasStateSubscribers() { return this.composition.hasStateSubscribers() }
	getActivePartialSnapshot() { return this.composition.getActivePartialSnapshot() }
	handlePartialIdle() { this.composition.handlePartialIdle() }
	requestStateBroadcast() { this.composition.requestStateBroadcast() }
	dispose() { return this.composition.dispose() }
	isScheduledAgentsEnabled() { return this.composition.isScheduledAgentsEnabled() }
	requestToolApproval(request: ApprovalRequestedEvent): Promise<ToolApprovalResult> { return this.composition.requestToolApproval(request) }
	requestQuestion(question: string, options: string[], signal?: AbortSignal): Promise<AskQuestionResult> { return this.composition.requestQuestion(question, options, signal) }
	handleSdkEvent(event: AgentRuntimeEvent) { this.composition.handleSdkEvent(event) }
	handle(envelope: WebviewEnvelope) { return this.composition.handle(envelope) }
	getUiLanguage() { return this.composition.getUiLanguage() }
	applyDefaultOllamaModel(modelId: string) { this.composition.applyDefaultOllamaModel(modelId) }
}
