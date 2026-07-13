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
import type { WebviewFeatures } from "./WebviewFeatureRegistry"

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

	setAgentEngine(value: WebviewFeatures["agentEngine"]) { this.composition.attachFeature("agentEngine", value) }
	setTaskSessionUseCase(value: WebviewFeatures["taskSessions"]) { this.composition.attachFeature("taskSessions", value) }
	setMcpHandler(value: WebviewFeatures["mcp"]) { this.composition.attachFeature("mcp", value) }
	setSendMessageHandler(value: WebviewFeatures["sendMessage"]) { this.composition.attachFeature("sendMessage", value) }
	setStartTaskHandler(value: WebviewFeatures["startTask"]) { this.composition.attachFeature("startTask", value) }
	setCancelTaskHandler(value: WebviewFeatures["cancelTask"]) { this.composition.attachFeature("cancelTask", value) }
	setBrowserHandler(value: WebviewFeatures["browser"]) { this.composition.attachFeature("browser", value) }
	getBrowserSettings() { return this.composition.getBrowserSettings() }
	setWorktreeQueryHandler(value: WebviewFeatures["worktreeQueries"]) { this.composition.attachFeature("worktreeQueries", value) }
	setWorktreeMutationHandler(value: WebviewFeatures["worktreeMutations"]) { this.composition.attachFeature("worktreeMutations", value) }
	setOAuthCallbackServices(authorization: WebviewFeatures["oauthAuthorization"], callback: WebviewFeatures["oauthCallback"]) { this.composition.attachFeature("oauthAuthorization", authorization); this.composition.attachFeature("oauthCallback", callback) }
	setProviderCredentialHandler(value: WebviewFeatures["providerCredentials"]) { this.composition.attachFeature("providerCredentials", value) }
	setProviderAuthActionHandler(value: WebviewFeatures["providerAuthActions"]) { this.composition.attachFeature("providerAuthActions", value) }
	setScheduledAgentHandler(value: WebviewFeatures["scheduledAgents"]) { this.composition.attachFeature("scheduledAgents", value) }
	setHookSettingsHandler(value: WebviewFeatures["hookSettings"]) { this.composition.attachFeature("hookSettings", value) }
	setHookExecutionHandler(value: WebviewFeatures["hookExecution"]) { this.composition.attachFeature("hookExecution", value) }
	setCheckpointHandler(value: WebviewFeatures["checkpoints"]) { this.composition.attachFeature("checkpoints", value) }
	setTerminalActivityMonitor(value: WebviewFeatures["terminalActivity"]) { this.composition.attachFeature("terminalActivity", value) }
	setTaskActivityMonitor(value: WebviewFeatures["taskActivity"]) { this.composition.attachFeature("taskActivity", value) }
	setPartialStateScheduler(value: WebviewFeatures["partialState"]) { this.composition.attachFeature("partialState", value) }
	setSendLatencyMonitor(value: WebviewFeatures["sendLatency"]) { this.composition.attachFeature("sendLatency", value) }
	setChangeTrackingHandler(value: WebviewFeatures["changeTracking"]) { this.composition.attachFeature("changeTracking", value) }
	setProviderModelCatalogHandler(value: WebviewFeatures["providerModelCatalogs"]) { this.composition.attachFeature("providerModelCatalogs", value) }
	setWebviewStreamPublisher(value: WebviewFeatures["streamPublisher"]) { this.composition.attachStreamPublisher(value) }
	setSdkSettingsHandler(value: WebviewFeatures["sdkSettings"]) { this.composition.attachFeature("sdkSettings", value) }

	serializeState() { return this.composition.serializeState() }
	publishChangeTranscript(text: string) { return this.composition.publishChangeTranscript(text) }
	updateTerminalActivity(text: string) { this.composition.updateTerminalActivity(text) }
	hasActiveTask() { return this.composition.hasActiveTask() }
	hasActivePartialText() { return this.composition.hasActivePartialText() }
	handleTaskIdleLongRunning() { this.composition.handleTaskIdleLongRunning() }
	hasStateSubscribers() { return this.composition.hasStateSubscribers() }
	getActivePartialSnapshot() { return this.composition.getActivePartialSnapshot() }
	handlePartialIdle() { this.composition.handlePartialIdle() }
	requestStateBroadcast() { this.composition.requestStateBroadcast() }
	dispose() { this.composition.dispose() }
	isScheduledAgentsEnabled() { return this.composition.isScheduledAgentsEnabled() }
	requestToolApproval(request: ApprovalRequestedEvent): Promise<ToolApprovalResult> { return this.composition.requestToolApproval(request) }
	requestQuestion(question: string, options: string[]): Promise<AskQuestionResult> { return this.composition.requestQuestion(question, options) }
	handleSdkEvent(event: AgentRuntimeEvent) { this.composition.handleSdkEvent(event) }
	handle(envelope: WebviewEnvelope) { return this.composition.handle(envelope) }
	getUiLanguage() { return this.composition.getUiLanguage() }
	applyDefaultOllamaModel(modelId: string) { this.composition.applyDefaultOllamaModel(modelId) }
}
