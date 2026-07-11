import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { AskQuestionResult, ToolApprovalResult } from "../../application/ports/AgentInteraction"
import type { AgentEnginePort } from "../../application/ports/AgentEnginePort"
import type { HostProviderPort } from "../../application/ports/HostProviderPort"
import type { InteractionLoggerPort } from "../../application/ports/InteractionLoggerPort"
import type { WebviewTransportPort } from "../../application/ports/WebviewTransportPort"
import type { WebviewApplicationPort } from "../../application/ports/WebviewApplicationPort"
import type { TaskSessionUseCase } from "../../application/useCases/TaskSessionUseCase"
import type { McpHandler } from "../../features/mcp/McpHandler"
import type { TaskLifecycleUseCase } from "../../application/useCases/TaskLifecycleUseCase"
import type { StatePersistenceUseCase } from "../../application/useCases/StatePersistenceUseCase"
import { HOST_SIDECAR_WEBVIEW_PROTOCOL_VERSION, type GrpcRequest, type WebviewEnvelope } from "../../application/dto/WebviewRpc"
import {
	createInitialState,
	createMcpServersLazyResponse,
	createPersistedStateSnapshot,
	createSdkCoverageState,
	loadInitialState,
} from "./WebviewState"
import { isTerminalTaskStatus, type TaskLifecycleStatus } from "../../domain/task/TaskLifecycle"
import type { AgentEvent, AgentRuntimeEvent } from "../../domain/agent/AgentRuntimeEvent"
import type { ApprovalRequestedEvent } from "../../domain/agent/AgentRuntimeEvent"
import type { SendMessageCommand } from "../../features/chat/sendMessage/SendMessageCommand"
import type { SendMessageHandler } from "../../features/chat/sendMessage/SendMessageHandler"
import type { StartTaskCommand } from "../../features/chat/startTask/StartTaskCommand"
import type { StartTaskHandler } from "../../features/chat/startTask/StartTaskHandler"
import type { CancelTaskHandler } from "../../features/chat/cancelTask/CancelTaskHandler"
import type { BrowserHandler, BrowserSettings } from "../../features/browser/BrowserHandler"
import type { WorktreeQueryHandler } from "../../features/worktrees/WorktreeQueryHandler"
import type { WorktreeMutationHandler } from "../../features/worktrees/WorktreeMutationHandler"
import type { OAuthAuthorizationHandler } from "../../features/providers/OAuthAuthorizationHandler"
import type { OAuthCallbackHandler } from "../../features/providers/OAuthCallbackHandler"
import type { ProviderCredentialHandler, ProviderCredentialMutation } from "../../features/providers/ProviderCredentialHandler"
import type { ProviderAuthActionHandler } from "../../features/providers/ProviderAuthActionHandler"
import { ApprovalCoordinator } from "../../features/approvals/ApprovalCoordinator"
import { rebindTaskHistoryId, upsertTaskHistoryItem } from "../../features/taskHistory/TaskHistoryCollection"
import {
	isOAuthTokenBlobProvider,
	normalizeProviderId,
	normalizeProviderValue,
	normalizeSdkProviderId,
	oauthCredentialsField,
	providerAuthLabel,
} from "../../application/services/ProviderIdentity"
import {
	checkIsImageUrl,
	fetchOpenGraphData,
} from "../browser/BrowserDevToolsAdapter"
import { browserActionResultForTranscript, normalizeBrowserActionName } from "../../features/browser/BrowserPolicy"
import {
	discoverLocalPlugins,
	getSettingsPath,
	getSidecarDataPath,
} from "../persistence/LocalAutomationStore"
import type { ScheduledAgentHandler } from "../../features/scheduledAgents/ScheduledAgentHandler"
import type { CheckpointHandler } from "../../features/checkpoints/CheckpointHandler"
import type { TerminalActivityMonitor } from "../conversation/TerminalActivityMonitor"
import { ConversationProjectionState, type ToolActivityEntry } from "../../features/conversation/ConversationProjectionState"
import type { TaskActivityMonitor } from "../../features/runtime/TaskActivityMonitor"
import type { PartialStateScheduler } from "../../features/runtime/PartialStateScheduler"
import type { SendLatencyMonitor } from "../../features/runtime/SendLatencyMonitor"
import type { ChangeTrackingHandler } from "../workspace/ChangeTrackingHandler"
import type { ProviderModelCatalogHandler } from "../models/ProviderModelCatalogHandler"
import type { WebviewStreamPublisher } from "./WebviewStreamPublisher"
import { TaskSnapshotStore } from "../../features/taskHistory/TaskSnapshotStore"
import { TaskHistorySync } from "../../features/taskHistory/TaskHistorySync"
import { TaskHistoryCommands } from "../../features/taskHistory/TaskHistoryCommands"
import { TaskTranscriptHydrator } from "../../features/taskHistory/TaskTranscriptHydrator"
import type { SdkSettingsHandler } from "../../features/settings/SdkSettingsHandler"
import { AgentTextEventProjector } from "../conversation/AgentTextEventProjector"
import { AgentToolEventProjector } from "../conversation/AgentToolEventProjector"
import { AgentLifecycleEventProjector } from "../conversation/AgentLifecycleEventProjector"
import { ApiConfigurationProfileManager } from "../configuration/ApiConfigurationProfileManager"
import { PartialTextProjector } from "../conversation/PartialTextProjector"
import { FoldedProgressProjector } from "../conversation/FoldedProgressProjector"
import {
	type HookLifecycleName,
	createHookMetadata,
} from "../hooks/HookRuntime"
import type { HookSettingsHandler } from "../../features/hooks/HookSettingsHandler"
import type { HookExecutionHandler, HookExecutionObserver } from "../../features/hooks/HookExecutionHandler"
import { applyPreToolUseInputPatch, type PreToolUseDecision } from "../../features/hooks/HookPolicy"
import {
	normalizeOllamaRootBaseUrl,
	normalizeOllamaOpenAiBaseUrl,
	inferModelInfo,
	inferContextWindow,
	inferMaxTokens,
	modelCapabilities,
	booleanField,
	modelInfoFromRemoteMetadata,
	parseModelPrice,
	getOllamaModels,
} from "../models/ModelCatalog"
import {
	RESUMED_CONVERSATION_MAX_CHARS,
	getCommandText,
	getToolPath,
	getToolPathFromUnknown,
	getSearchQuery,
	getSearchFilePattern,
	summarizeToolInput,
	getPatchPathsFromUnknown,
	parsePatchPaths,
	summarizeCommandLabel,
	sanitizeConsoleOutput,
	stripCommandSentinel,
	tryParseJson,
	getAskResponseText,
	firstString,
	findLastIndex,
	shouldAutoApproveTool,
	normalizeClineMessagePayload,
	isMeaninglessToolMessage,
	isMeaninglessPlaceholderMessage,
	isMeaninglessTextMessage,
	isJsonObjectString,
	isEmptyJsonObjectString,
	isEmptyTranscriptPlaceholder,
	isEmptyPlainObject,
	toProtoAsk,
	toProtoSay,
	buildTaskInputWithAttachments,
	normalizeSdkImageInputs,
	normalizeSdkImageInput,
	fileUrlToPath,
	tryCreateImageDataUri,
	getImageMimeType,
	formatAttachmentSummaryValue,
	getExternalUrlValue,
	normalizeMcpDisplayMode,
	normalizeUsageSnapshot,
	createId,
	createHistoryItem,
	sdkSessionToHistoryItem,
	sdkMessagesToClineMessages,
	stripLegacyMcpContext,
	sdkMessageTimestamp,
	normalizeTimestamp,
	stableSessionBaseTimestamp,
	hashString,
	sdkContentToVisibleAssistantText,
	sdkContentToReasoningText,
	sdkContentToToolActivityEntries,
	extractCompletionTextFromResult,
	completionCandidateToText,
	completionContentBlocksToText,
	agentChunkToTranscriptText,
	agentChunkToFoldedReasoningText,
	agentChunkToTerminalResult,
	agentChunkRecordToTerminalResult,
	agentChunkStringToTranscriptText,
	agentChunkStringToFoldedReasoningText,
	parseJsonObjectSequence,
	agentChunkRecordToTranscriptText,
	agentChunkRecordToFoldedReasoningText,
	isKnownAgentEventRecord,
	agentContentEventToText,
	unknownAgentChunkTextToTranscriptText,
	shouldFoldTextContentAsReasoning,
	shouldDelayAssistantTextUntilClassified,
	stripRawToolCallMarkup,
	normalizeAssistantTranscriptText,
	buildResumedConversationMessages,
	clineMessageToResumedTranscriptEntry,
	resumedTranscriptTextForMessage,
	mergeTextDelta,
	looksLikeTokenizedReasoning,
	looksLikeReasoningNarration,
	isToolTranscript,
	toolInputToText,
	toolResultToText,
	stringifyPretty,
	normalizeTranscriptText,
	mapToolName,
	toolActivityEntriesFromMessage,
	toolTranscriptToActivityEntries,
	buildGroupedToolActivityText,
	formatToolActivitySection,
	normalizeTerminalOutputText,
	toolActivityEntryKey,
	uniqueToolActivityEntries,
	splitToolPaths,
	looksLikeCommandText,
	uniqueStrings,
} from "../conversation/ConversationSupport"
import {
	type OAuthTokenExchangeConfig,
	compactApiConfiguration,
	resolveConfiguredContextWindow,
	positiveIntegerValue,
	resolveApiKey,
	providerCredentialFields,
	providerCredentialField,
	extractProviderCredentialValue,
	providerBaseUrlField,
	resolveBaseUrl,
	resolveProviderEnvApiKey,
	resolveProviderEnvBaseUrl,
	pickApiConfigurationFields,
	extractApiConfigurationUpdate,
	normalizeApiConfiguration,
	normalizeApiConfigurationProfiles,
	normalizePreferredLanguage,
	resolveOAuthCredentials,
	describeOAuthCredentialState,
	extractAutoApprovalSettingsUpdate,
	isAutoApprovalSettingsLike,
	createToolPolicies,
	isPlanModeBlockedTool,
	isWebFetchEnabled,
	webFetchDisabledReason,
	isRuntimeSettingsKey,
} from "../configuration/ProviderConfiguration"
import { resolveModelId, selectProvider } from "../../features/providers/ProviderSelection"
import { resolveRequestedPlanActMode } from "../../features/settings/PlanActMode"
import {
	createUnauthenticatedAccountState,
	createVisualStudioAuthUnsupportedResponse,
	isOAuthBridgeProvider,
} from "../auth/ProviderAuthSupport"

export class VisualStudioWebviewBackend implements WebviewApplicationPort {
	private agentEngine: AgentEnginePort | null = null
	private taskSessions: TaskSessionUseCase | null = null
	private mcp: McpHandler | null = null
	private sendMessage: SendMessageHandler | null = null
	private startTaskHandler: StartTaskHandler | null = null
	private cancelTaskHandler: CancelTaskHandler | null = null
	private browserHandler: BrowserHandler | null = null
	private worktreeQueries: WorktreeQueryHandler | null = null
	private worktreeMutations: WorktreeMutationHandler | null = null
	private readonly mcpServerStreamRequestIds = new Set<string>()
	private readonly state: ReturnType<typeof createInitialState>
	private readonly approvals = new ApprovalCoordinator()
	private pendingQuestion:
		| {
				resolve: (value: AskQuestionResult) => void
		  }
		| null = null
	private messageSequence = 0
	private readonly conversationProjection = new ConversationProjectionState()
	private readonly partialTextProjector: PartialTextProjector
	private readonly foldedProgressProjector: FoldedProgressProjector
	private readonly taskSnapshots: TaskSnapshotStore
	private readonly taskHistorySync: TaskHistorySync
	private readonly taskHistoryCommands: TaskHistoryCommands
	private readonly taskTranscriptHydrator: TaskTranscriptHydrator
	private readonly agentTextEvents: AgentTextEventProjector
	private readonly agentToolEvents: AgentToolEventProjector
	private readonly agentLifecycleEvents: AgentLifecycleEventProjector
	private readonly apiConfigurationProfiles: ApiConfigurationProfileManager
	private stateHydrationRefreshInFlight = false
	private readonly closingSessionIds = new Set<string>()
	private sdkRunGeneration = 0
	private runtimeSettingsRevision = 0
	private activeSessionRuntimeSettingsRevision = 0
	private oauthAuthorization: OAuthAuthorizationHandler | null = null
	private oauthCallbackHandler: OAuthCallbackHandler | null = null
	private providerCredentials: ProviderCredentialHandler | null = null
	private providerAuthActions: ProviderAuthActionHandler | null = null
	private scheduledAgents: ScheduledAgentHandler | null = null
	private hookSettings: HookSettingsHandler | null = null
	private hookExecution: HookExecutionHandler | null = null
	private checkpoints: CheckpointHandler | null = null
	private terminalActivity: TerminalActivityMonitor | null = null
	private taskActivity: TaskActivityMonitor | null = null
	private partialStateScheduler: PartialStateScheduler | null = null
	private sendLatency: SendLatencyMonitor | null = null
	private changeTracking: ChangeTrackingHandler | null = null
	private providerModelCatalogs: ProviderModelCatalogHandler | null = null
	private streamPublisher: WebviewStreamPublisher | null = null
	private sdkSettings: SdkSettingsHandler | null = null

	private readonly inertStreams = new Set([
		"UiService.subscribeToMcpButtonClicked",
		"UiService.subscribeToHistoryButtonClicked",
		"UiService.subscribeToChatButtonClicked",
		"UiService.subscribeToSettingsButtonClicked",
		"UiService.subscribeToWorktreesButtonClicked",
		"UiService.subscribeToAccountButtonClicked",
		"UiService.subscribeToRelinquishControl",
		"UiService.subscribeToShowWebview",
		"UiService.subscribeToAddToInput",
		"McpService.subscribeToMcpMarketplaceCatalog",
		"ModelsService.subscribeToOpenRouterModels",
		"ModelsService.subscribeToLiteLlmModels",
	])

	constructor(
		private readonly host: HostProviderPort,
		private readonly transport: WebviewTransportPort,
		private readonly logger: InteractionLoggerPort,
		private readonly stateStore: StatePersistenceUseCase,
		private readonly taskLifecycle: TaskLifecycleUseCase,
	) {
		this.state = loadInitialState(this.stateStore.load())
		this.taskSnapshots = new TaskSnapshotStore(this.state.taskSnapshots, (snapshots) => { this.state.taskSnapshots = snapshots })
		this.apiConfigurationProfiles = new ApiConfigurationProfileManager({ readConfiguration: () => asRecord(this.state.apiConfiguration), writeConfiguration: (configuration) => { this.state.apiConfiguration = configuration as typeof this.state.apiConfiguration }, readProfiles: () => this.state.apiConfigurationProfiles, writeProfiles: (profiles) => { this.state.apiConfigurationProfiles = profiles }, readActiveId: () => this.state.activeApiConfigurationProfileId, writeActiveId: (profileId) => { this.state.activeApiConfigurationProfileId = profileId }, readSeparateModels: () => this.state.planActSeparateModelsSetting, writeSeparateModels: (enabled) => { this.state.planActSeparateModelsSetting = enabled } })
		this.taskHistorySync = new TaskHistorySync({ isAvailable: () => Boolean(this.clineSdk), listHistory: () => this.clineSdk?.listHistory({ limit: 200 }) ?? Promise.resolve(null), projectSession: (session) => sdkSessionToHistoryItem(asRecord(session)), readHistory: () => this.state.taskHistory, writeHistory: (history) => { this.state.taskHistory = history }, broadcast: () => this.broadcastState(), log: (event, details) => this.logger.log("sidecar", event, details) })
		this.taskHistoryCommands = new TaskHistoryCommands({ readHistory: () => this.state.taskHistory, writeHistory: (history) => { this.state.taskHistory = history }, readCurrentTask: () => this.state.currentTaskItem, writeCurrentTask: (task) => { this.state.currentTaskItem = task }, clearMessages: () => { this.state.clineMessages = [] }, clearLiveInteraction: (reason) => this.clearLiveInteractionState(reason), markDeleted: (taskId) => this.taskHistorySync.markDeleted(taskId), removeDeleted: (history) => this.taskHistorySync.removeDeleted(history), listRemoteTaskIds: async () => { if (!this.clineSdk) return []; const sessions = await this.clineSdk.listHistory({ limit: 1000 }); return Array.isArray(sessions) ? sessions.map((session) => getString(asRecord(session), "id") || getString(asRecord(session), "sessionId")).filter(Boolean) : [] }, deleteRemote: (taskId) => this.clineSdk?.deleteSession({ sessionId: taskId }) ?? Promise.resolve(undefined), updateRemoteFavorite: (taskId, isFavorited) => this.clineSdk?.updateSession({ sessionId: taskId, metadata: { isFavorited } }) ?? Promise.resolve(undefined), getSnapshot: (taskId) => this.getTaskSnapshot(taskId), rememberSnapshot: (taskId, task, messages) => this.rememberTaskSnapshot(taskId, task, messages), forgetSnapshot: (taskId) => this.forgetTaskSnapshot(taskId), clearSnapshots: () => this.clearTaskSnapshots(), persist: () => this.stateStore.save(createPersistedStateSnapshot(this.state)), log: (event, details) => this.logger.log("sidecar", event, details) })
		this.taskTranscriptHydrator = new TaskTranscriptHydrator({
			isAvailable: () => Boolean(this.clineSdk && this.taskSessions),
			readCurrentTask: () => this.state.currentTaskItem,
			activeSessionId: () => this.clineSdk?.status.activeSessionId || "",
			hasLiveProjection: () => Boolean(this.conversationProjection.activePartialTextTs || this.conversationProjection.activeReasoningTextTs || this.conversationProjection.activeToolActivityTs),
			readMessages: () => this.state.clineMessages,
			loadTranscript: (taskId) => this.taskSessions?.load(taskId) ?? Promise.resolve(null),
			activateTranscript: (taskId) => this.taskSessions!.activateAndRead(taskId),
			getSnapshot: (taskId) => this.getTaskSnapshot(taskId),
			prepareActivation: (taskId) => { this.closingSessionIds.delete(taskId) },
			clearLiveInteraction: (reason) => this.clearLiveInteractionState(reason),
			projectSession: (session) => sdkSessionToHistoryItem(asRecord(session)),
			projectMessages: (messages, task) => sdkMessagesToClineMessages(messages, task),
			applySelected: (taskId, task, messages) => { this.state.currentTaskItem = task; this.state.clineMessages = messages; this.rememberTaskSnapshot(taskId, task, messages); this.schedulePersistedStateSave() },
			applyShown: (taskId, task, messages) => { this.state.currentTaskItem = task; this.state.clineMessages = messages; this.rememberTaskSnapshot(taskId, task, messages); this.stateStore.save(createPersistedStateSnapshot(this.state)) },
			applyCompleted: (taskId, task, messages) => { this.clearTaskIdleWatchdog(); this.clearPartialIdleWatchdog(); this.clearReasoningStatus(); this.conversationProjection.activePartialTextTs = null; this.conversationProjection.activeReasoningTextTs = null; this.conversationProjection.activeToolActivityTs = null; this.conversationProjection.activeAssistantTextBuffer = ""; this.state.currentTaskItem = task; this.state.clineMessages = messages; this.finalizeOpenPartialMessages(); this.addCompletionResultMarker("completed"); this.updateCurrentTaskItem(); this.rememberTaskSnapshot(taskId, task, this.state.clineMessages); this.schedulePersistedStateSave() },
			summarizeMessage: (message) => summarizeClineMessageForLog(message),
			log: (event, details) => this.logger.log("sidecar", event, details),
			broadcast: () => this.broadcastState(),
			isSessionNotFound: (error) => isSessionNotFoundError(error),
		})
		this.partialTextProjector = new PartialTextProjector(this.conversationProjection, () => this.state.clineMessages, () => Date.now() + this.messageSequence++, (timestamp, updates) => this.upsertMessage(timestamp, updates), (message) => this.sendPartialMessage(message), () => this.schedulePartialIdleWatchdog(), () => this.clearPartialIdleWatchdog(), () => this.clearPartialStateBroadcastTimer(), () => this.broadcastPartialStateNow(), () => this.schedulePartialStateBroadcast())
		this.foldedProgressProjector = new FoldedProgressProjector(this.conversationProjection, () => this.state.clineMessages, () => Date.now() + this.messageSequence++, (timestamp, updates) => this.upsertMessage(timestamp, updates), (message) => this.sendPartialMessage(message), () => this.broadcastPartialStateNow(), () => this.schedulePartialStateBroadcast(), () => this.stopTerminalStatePolling(), () => this.getUiLanguage())
		this.agentTextEvents = new AgentTextEventProjector({ noteActivity: (reason) => this.noteTaskActivity(reason), clearReasoning: () => this.clearReasoningStatus(), recordReasoning: (text) => this.handleReasoningDelta(text), foldReasoning: (text) => this.upsertFoldedReasoningText(text), upsertAssistant: (accumulated, delta) => this.upsertAssistantTextFromEvent(accumulated, delta), completeAssistant: (text) => this.completeAssistantText(text), activeAssistantText: () => this.conversationProjection.activeAssistantTextBuffer })
		this.agentToolEvents = new AgentToolEventProjector({ noteActivity: (reason) => this.noteTaskActivity(reason), clearReasoning: () => this.clearReasoningStatus(), clearPartial: () => { this.clearPartialIdleWatchdog(); this.conversationProjection.activePartialTextTs = null }, recordActivity: (tool, text) => this.recordToolActivity(tool, text), startTerminal: () => this.startTerminalStatePolling(), stopTerminal: () => this.stopTerminalStatePolling(), finalPollTerminal: () => { this.pollTerminalState().catch((error) => this.logger.log("sidecar", "terminalStateFinalPollFailed", { message: stringify(error) })) }, postToolUse: (event) => { void this.runLifecycleHooks("PostToolUse", { sessionId: event.sessionId, toolName: event.toolName, input: event.input, output: event.output, error: event.error, iteration: event.iteration }) }, handleBrowser: (tool, input, error) => { void this.handleBrowserToolEvent(tool, input, error) }, shouldSuppressTrackedEdit: (tool, path) => (tool === "editor" || tool === "edit") && (this.hasRecentlyTrackedChange() || Boolean(path && this.wasRecentlyTracked(path))), rememberSummary: (tool, text) => this.rememberToolSummary(tool, text), appendTerminal: (text) => this.appendTerminalActivityText(text), moveProgressToEnd: () => this.foldedProgressProjector.moveActiveToEnd(), language: () => this.getUiLanguage() })
		this.agentLifecycleEvents = new AgentLifecycleEventProjector({ noteActivity: (reason) => this.noteTaskActivity(reason), clearReasoning: () => this.clearReasoningStatus(), finishToolActivity: () => this.finishActiveToolActivity(), finishProgress: () => this.finishFoldedReasoningText(), finalizePartial: () => this.finalizeActivePartialText(), addText: (text) => this.addMessage({ type: "say", say: "text", text }), addError: (text) => this.addMessage({ type: "say", say: "error", text }), finishTask: (sessionId, status, text) => this.finishSdkTask(sessionId, status, text), updateUsage: (usage) => this.updateCurrentTaskItem(usage), hasCompletion: () => this.hasCompletionResultAfterLastUserMessage(), activePartialText: () => this.getActivePartialText(), hasAssistantAfterUser: () => this.hasAssistantTextAfterLastUserMessage(), log: (event, details) => this.logger.log("sidecar", event, details), formatError: (error) => formatProviderErrorForTranscript(error, this.getUiLanguage()), markErrorLatency: (sessionId, error) => this.markSendLatencyError(sessionId, error) })
		this.taskLifecycle.initialize(this.state.currentTaskItem ? "completed" : "idle")
		this.state.taskLifecycleStatus = this.taskLifecycle.status
	}

	setAgentEngine(agentEngine: AgentEnginePort) {
		this.agentEngine = agentEngine
	}

	// Transitional facade alias. Feature slices should receive AgentEnginePort
	// directly as they are extracted from this legacy backend.
	private get clineSdk() {
		return this.agentEngine
	}

	setTaskSessionUseCase(taskSessions: TaskSessionUseCase) {
		this.taskSessions = taskSessions
	}

	setMcpHandler(mcp: McpHandler) {
		this.mcp = mcp
	}

	setSendMessageHandler(sendMessage: SendMessageHandler) {
		this.sendMessage = sendMessage
	}

	setStartTaskHandler(startTaskHandler: StartTaskHandler) { this.startTaskHandler = startTaskHandler }
	setCancelTaskHandler(cancelTaskHandler: CancelTaskHandler) { this.cancelTaskHandler = cancelTaskHandler }
	setBrowserHandler(browserHandler: BrowserHandler) { this.browserHandler = browserHandler }
	setWorktreeQueryHandler(worktreeQueries: WorktreeQueryHandler) { this.worktreeQueries = worktreeQueries }
	setWorktreeMutationHandler(worktreeMutations: WorktreeMutationHandler) { this.worktreeMutations = worktreeMutations }
	setOAuthCallbackServices(oauthAuthorization: OAuthAuthorizationHandler, oauthCallbackHandler: OAuthCallbackHandler) { this.oauthAuthorization = oauthAuthorization; this.oauthCallbackHandler = oauthCallbackHandler }
	setProviderCredentialHandler(providerCredentials: ProviderCredentialHandler) { this.providerCredentials = providerCredentials }
	setProviderAuthActionHandler(providerAuthActions: ProviderAuthActionHandler) { this.providerAuthActions = providerAuthActions }
	setScheduledAgentHandler(scheduledAgents: ScheduledAgentHandler) { this.scheduledAgents = scheduledAgents }
	setHookSettingsHandler(hookSettings: HookSettingsHandler) { this.hookSettings = hookSettings }
	setHookExecutionHandler(hookExecution: HookExecutionHandler) { this.hookExecution = hookExecution }
	setCheckpointHandler(checkpoints: CheckpointHandler) { this.checkpoints = checkpoints }
	setTerminalActivityMonitor(terminalActivity: TerminalActivityMonitor) { this.terminalActivity = terminalActivity }
	setTaskActivityMonitor(taskActivity: TaskActivityMonitor) { this.taskActivity = taskActivity }
	setPartialStateScheduler(partialStateScheduler: PartialStateScheduler) { this.partialStateScheduler = partialStateScheduler }
	setSendLatencyMonitor(sendLatency: SendLatencyMonitor) { this.sendLatency = sendLatency }
	setChangeTrackingHandler(changeTracking: ChangeTrackingHandler) { this.changeTracking = changeTracking }
	setProviderModelCatalogHandler(providerModelCatalogs: ProviderModelCatalogHandler) { this.providerModelCatalogs = providerModelCatalogs }
	setWebviewStreamPublisher(streamPublisher: WebviewStreamPublisher) { this.streamPublisher = streamPublisher }
	setSdkSettingsHandler(sdkSettings: SdkSettingsHandler) { this.sdkSettings = sdkSettings }
	serializeState() { return JSON.stringify(this.state) }
	async publishChangeTranscript(text: string) { this.addMessage({ type: "say", say: "tool", text }); this.updateCurrentTaskItem(); await this.broadcastState() }
	updateTerminalActivity(text: string) { this.conversationProjection.activeTerminalActivityText = text; this.foldedProgressProjector.refresh(); this.updateCurrentTaskItem() }
	hasActiveTask() { return Boolean(this.state.currentTaskItem) }
	hasActivePartialText() { return Boolean(this.conversationProjection.activePartialTextTs) }
	handleTaskIdleLongRunning() { this.updateCurrentTaskItem(); this.broadcastState().catch((error) => console.error(error)) }
	hasStateSubscribers() { return this.streamPublisher?.hasStateSubscribers === true }
	getActivePartialSnapshot() { const message = this.state.clineMessages.find((item) => item.ts === this.conversationProjection.activePartialTextTs); const text = getString(message, "text"); return this.conversationProjection.activePartialTextTs && text.trim() ? { textLength: text.length } : null }
	handlePartialIdle() { this.updateCurrentTaskItem(); this.broadcastState().catch((error) => console.error(error)) }
	requestStateBroadcast() { this.broadcastState().catch((error) => console.error(error)) }

	dispose() {
		this.clearPartialIdleWatchdog()
		this.clearPartialStateBroadcastTimer()
		this.clearTaskIdleWatchdog()
		this.terminalActivity?.dispose()
		this.changeTracking?.dispose()
		this.streamPublisher?.dispose()
		this.mcpServerStreamRequestIds.clear()
		this.approvals.clear({ approved: false, reason: "LIG VS webview router was disposed." })
		this.pendingQuestion?.resolve("")
		this.pendingQuestion = null
		this.flushPersistedStateSave()
		this.oauthAuthorization?.dispose()
	}

	isScheduledAgentsEnabled() {
		return this.state.scheduledAgentsEnabled === true || process.env.VSCLINE_ENABLE_AUTOMATION === "1"
	}

	private createCurrentToolPolicies() {
		const policies = createToolPolicies(this.state.autoApprovalSettings, this.state.browserSettings, this.state.mode)
		if (this.state.mode === "plan") {
			this.logger.log("sidecar", "sdkModePolicy.plan", {})
		}
		return policies
	}

	private isPlanModeToolBlocked(mappedToolName: string) {
		if (this.state.mode !== "plan") {
			return false
		}
		return isPlanModeBlockedTool(mappedToolName)
	}

	async requestToolApproval(request: ApprovalRequestedEvent): Promise<ToolApprovalResult> {
		this.logger.log("sdk->sidecar", "toolApproval.request", request)
		const approvalRequest = request.raw as Record<string, unknown>
		const toolName = request.toolName
		const input = request.input as Record<string, unknown>
		const mappedToolName = mapToolName(toolName)
		if (this.isPlanModeToolBlocked(mappedToolName)) {
			const language = this.getUiLanguage()
			const reason =
				language === "ko"
					? "Plan 모드에서는 실행/수정/브라우저/MCP 도구를 실행하지 않습니다. Act 모드로 전환한 뒤 다시 시도해 주세요."
					: "Plan mode does not run execution, edit, browser, or MCP tools. Switch to Act mode and try again."
			this.addMessage({
				type: "say",
				say: "info",
				text: reason,
			})
			this.updateCurrentTaskItem()
			await this.broadcastState()
			return { approved: false, reason }
		}
		const hookDecision = await this.runPreToolUseHooks({
			sessionId: this.clineSdk?.status.activeSessionId || String(this.state.currentTaskItem?.id || ""),
			toolName,
			mappedToolName,
			input,
			approvalRequest,
		})
		if (hookDecision.blocked) {
			return { approved: false, reason: hookDecision.reason || "Blocked by PreToolUse hook." }
		}
		if (hookDecision.inputPatch && Object.keys(hookDecision.inputPatch).length > 0) {
			applyPreToolUseInputPatch(input, approvalRequest, hookDecision)
			this.logger.log("sidecar", "preToolUseInputPatched", {
				toolName,
				mappedToolName,
				replaceInput: hookDecision.replaceInput === true,
				keys: Object.keys(hookDecision.inputPatch),
				reason: hookDecision.reason || undefined,
			})
		}
		if (shouldAutoApproveTool(toolName, this.state.autoApprovalSettings)) {
			await this.notifyAutoApprovedTool(mappedToolName, input)
			return { approved: true, reason: "Auto-approved by Visual Studio settings." }
		}
		const ask = mappedToolName === "executeCommand" ? "command" : "tool"
		const text =
			ask === "command"
				? JSON.stringify({
						command: getCommandText(input),
						description: getString(approvalRequest, "description") || getString(approvalRequest, "reason") || "LIG VS가 이 명령을 실행하려고 합니다.",
					})
				: JSON.stringify({
						tool: mappedToolName,
						path:
							mappedToolName === "searchFiles"
								? getToolPath(input) || "/"
								: getPatchPathsFromUnknown(input) || getToolPathFromUnknown(input),
						regex: mappedToolName === "searchFiles" ? getSearchQuery(input) : undefined,
						filePattern: mappedToolName === "searchFiles" ? getSearchFilePattern(input) : undefined,
						content: getString(approvalRequest, "description") || getString(approvalRequest, "reason") || summarizeToolInput(input),
						...input,
					})

		this.transitionTask("awaiting_user", "tool-approval")
		this.taskLifecycle.waitFor("tool_approval")
		this.addMessage({ type: "ask", ask, text })
		this.updateCurrentTaskItem()
		await this.broadcastState()

		return this.approvals.request()
	}

	private async notifyAutoApprovedTool(mappedToolName: string, input: Record<string, unknown>) {
		const settings = asRecord(this.state.autoApprovalSettings)
		if (settings.enableNotifications !== true) {
			return
		}

		const detail =
			mappedToolName === "executeCommand"
				? getCommandText(input)
				: getPatchPathsFromUnknown(input) || getToolPathFromUnknown(input) || getSearchQuery(input)
		const suffix = detail ? `: ${truncateForStatus(detail, 120)}` : ""
		try {
			await this.host.windowClient.showMessage({
				message: `LIG VS auto-approved ${mappedToolName}${suffix}`,
				type: "info",
			})
		} catch (error) {
			this.logger.log("sidecar", "autoApproveNotificationFailed", { error: stringify(error) })
		}
	}

	async requestQuestion(question: string, options: string[]): Promise<AskQuestionResult> {
		this.transitionTask("awaiting_user", "question")
		this.taskLifecycle.waitFor("question")
		this.logger.log("sdk->sidecar", "question.request", { question, options })
		if (this.pendingQuestion) {
			this.pendingQuestion.resolve("")
			this.pendingQuestion = null
		}
		this.removeAskMessages("followup")

		this.addMessage({
			type: "ask",
			ask: "followup",
			text: JSON.stringify({
				question,
				options,
			}),
		})
		this.updateCurrentTaskItem()
		await this.broadcastState()

		return new Promise<AskQuestionResult>((resolve) => {
			this.pendingQuestion = { resolve }
		})
	}

	handleSdkEvent(event: AgentRuntimeEvent) {
		if (shouldLogSdkEventForInteraction(event)) {
			this.logger.log("sdk->sidecar", "sdk.event", summarizeSdkEventForLog(event))
		}
		const type = event.type === "unknown" ? event.originalType : event.type
		const payload = event.payload
		if (type && type !== "vscline_file_changed" && type !== "status" && type !== "ended") {
			this.transitionTask("streaming", `sdk:${type}`)
		}

		if (event.type === "agent_event") {
			const sessionId = event.sessionId
			if (this.shouldIgnoreSdkEvent(sessionId)) {
				this.logger.log("sidecar", "ignoredSdkAgentEvent", {
					sessionId,
					activeSessionId: this.clineSdk?.status.activeSessionId,
					currentTaskId: this.state.currentTaskItem?.id,
				})
				return
			}
			this.markSendLatencyFirstSdkEvent(sessionId, event.event.type)
			this.handleAgentEvent(event.event, sessionId)
			return
		}

		if (event.type === "vscline_file_changed") {
			this.handleFileChangedEvent(payload).catch((error) => console.error(error))
			return
		}

		if (event.type === "chunk") {
			const sessionId = event.sessionId
			if (this.shouldIgnoreSdkEvent(sessionId)) {
				return
			}
			this.markSendLatencyFirstSdkEvent(sessionId, type)
			this.handleSessionChunk(payload)
			return
		}

		if (event.type === "session_snapshot") {
			const sessionId = event.sessionId
			if (this.shouldIgnoreSdkEvent(sessionId)) {
				return
			}
			this.markSendLatencyFirstSdkEvent(sessionId, type)
			this.handleSessionSnapshot(payload)
			return
		}

		if (event.type === "team_progress") {
			const sessionId = event.sessionId
			if (this.shouldIgnoreSdkEvent(sessionId)) {
				return
			}
			this.handleTeamProgress(payload)
			return
		}

		if (event.type === "hook") {
			const sessionId = event.sessionId
			if (this.shouldIgnoreSdkEvent(sessionId)) {
				return
			}
			this.handleHookEvent(payload)
			return
		}

		if (event.type === "pending_prompts") {
			const sessionId = event.sessionId
			if (this.shouldIgnoreSdkEvent(sessionId)) {
				return
			}
			this.handlePendingPrompts(payload)
			return
		}

		if (event.type === "pending_prompt_submitted") {
			const sessionId = event.sessionId
			if (this.shouldIgnoreSdkEvent(sessionId)) {
				return
			}
			this.handlePendingPromptSubmitted(payload)
			return
		}

		if (event.type === "status") {
			const status = event.status
			const sessionId = event.sessionId
			if (this.shouldIgnoreSdkEvent(sessionId)) {
				return
			}
			this.markSendLatencyFirstSdkEvent(sessionId, `status:${status}`)
			if (status === "idle") {
				this.logger.log("sidecar", "sdkStatusIdle", { sessionId })
				this.finishSdkTask(sessionId, "completed", this.getActivePartialText())
				this.updateCurrentTaskItem()
				this.broadcastState().catch((error) => console.error(error))
				return
			}
			if (isTerminalTaskStatus(status)) {
				const activeText = this.getActivePartialText()
				this.finishSdkTask(sessionId, status, activeText)
				this.updateCurrentTaskItem()
				this.broadcastState().catch((error) => console.error(error))
				return
			}
			this.transitionTask("streaming", `sdk-status:${status || "unknown"}`)
			this.noteTaskActivity(status || type)
			this.schedulePartialStateBroadcast()
			return
		}

		if (event.type === "ended") {
			const sessionId = event.sessionId
			if (this.shouldIgnoreSdkEvent(sessionId)) {
				return
			}
			const activeText = this.getActivePartialText()
			this.finishSdkTask(sessionId, event.reason || "ended", activeText)
			this.updateCurrentTaskItem()
			this.broadcastState().catch((error) => console.error(error))
		}
	}

	async handle(envelope: WebviewEnvelope) {
		this.logger.log("webview->sidecar", envelope.type === "unhandled" ? envelope.originalType || "webview.message" : envelope.type, envelope)

		if (envelope.type === "grpc_request") {
			const handledGrpc = await this.handleGrpcRequest(envelope.request)
			if (handledGrpc) {
				return handledGrpc
			}
		}

		if (envelope.type === "grpc_request_cancel") {
			const requestId = envelope.requestId
			if (this.disposeStreamRequest(requestId)) {
				this.logger.log("webview->sidecar", "grpc_request_cancel.streamDisposed", { requestId })
				return {
					handled: true,
					owner: "sidecar",
					webviewMessages: [],
				}
			}
			this.logger.log("webview->sidecar", "grpc_request_cancel.ignored", { requestId })
			return {
				handled: true,
				owner: "sidecar",
				webviewMessages: [],
			}
		}

		return {
			handled: false,
			type: envelope.type === "unhandled" ? envelope.originalType : envelope.type,
			webviewMessages: [],
		}
	}

	private async handleGrpcRequest(request: GrpcRequest) {
		this.logger.log("webview->sidecar", `${request.service}.${request.method}`, request)
		const startedAt = Date.now()
		const service = request.service
		const method = request.method
		const requestId = request.requestId
		const isStreaming = request.isStreaming
		const key = `${service}.${method}`

		if (isStreaming) {
			const result = await this.handleStreamingRequest(key, requestId)
			this.logSlowGrpcRequest(key, startedAt, true)
			return result
		}

		try {
			const result = await this.handleUnaryRequest(key, requestId, request.message)
			this.logSlowGrpcRequest(key, startedAt, false)
			return result
		} catch (error) {
			this.logSlowGrpcRequest(key, startedAt, false)
			const message = error instanceof Error ? error.message : String(error)
			this.addMessage({ type: "say", say: "error", text: message })
			this.updateCurrentTaskItem()
			await this.broadcastState()
			return grpcHandled(grpcError(requestId, message, false))
		}
	}

	private async handleStreamingRequest(key: string, requestId: string) {
		if (key === "StateService.subscribeToState") {
			this.scheduleStateStreamsRefresh()
			return grpcHandled(this.requireStreamPublisher().subscribeState(requestId))
		}

		if (key === "AccountService.subscribeToAuthStatusUpdate") {
			return grpcHandled(grpcResponse(requestId, createUnauthenticatedAccountState(), true))
		}

		if (key === "UiService.subscribeToPartialMessage") {
			this.requireStreamPublisher().subscribePartial(requestId)
			return grpcHandled()
		}

		if (key === "McpService.subscribeToMcpServers") {
			this.mcpServerStreamRequestIds.add(requestId)
			return grpcHandled(grpcResponse(requestId, await this.getMcpServersResponse(), true))
		}

		if (key === "McpService.subscribeToMcpMarketplaceCatalog") {
			return grpcHandled(grpcResponse(requestId, this.getMcpMarketplaceResponse(), true))
		}

		if (key === "OcaAccountService.ocaSubscribeToAuthStatusUpdate") {
			return grpcHandled(grpcResponse(requestId, createUnauthenticatedAccountState(), true))
		}

		if (this.inertStreams.has(key)) {
			return {
				handled: true,
				owner: "sidecar",
				reason: "registered_inert_stream",
				webviewMessages: [],
			}
		}

		return null
	}

	private async handleUnaryRequest(key: string, requestId: string, message: unknown) {
		const host = this.host

		switch (key) {
			case "UiService.initializeWebview":
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "UiService.onDidShowAnnouncement":
				return grpcHandled(grpcResponse(requestId, { value: false }, false))

			case "UiService.openUrl":
				await host.envClient.openExternal({ value: getExternalUrlValue(message) })
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "UiService.openWalkthrough":
			case "UiService.setTerminalExecutionMode":
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "WebService.openInBrowser":
				await host.envClient.openExternal({ value: getExternalUrlValue(message) })
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "WebService.checkIsImageUrl":
				return grpcHandled(grpcResponse(requestId, await checkIsImageUrl(getString(message, "value") || getString(message, "url")), false))

			case "WebService.fetchOpenGraphData":
				return grpcHandled(grpcResponse(requestId, await fetchOpenGraphData(getString(message, "value") || getString(message, "url")), false))

			case "AccountService.getRedirectUrl":
				return grpcHandled(grpcResponse(requestId, await this.createOAuthCallbackBridgeResponse(message, "account"), false))

			case "AccountService.getUserOrganizations":
				return grpcHandled(grpcResponse(requestId, { organizations: [] }, false))

			case "AccountService.getUserCredits":
			case "AccountService.getOrganizationCredits":
				return grpcHandled(grpcResponse(requestId, { credits: 0, balance: 0, value: 0 }, false))

			case "AccountService.setUserOrganization":
			case "AccountService.submitLimitIncreaseRequest":
				return grpcHandled(grpcResponse(requestId, createVisualStudioAuthUnsupportedResponse("account"), false))

			case "AccountService.accountLoginClicked":
				return grpcHandled(grpcResponse(requestId, await this.handleAccountAuthAction("account"), false))

			case "AccountService.accountLogoutClicked":
				this.state.openAiCodexIsAuthenticated = false
				await this.clearOAuthCredential("account")
				await this.clearOAuthCredential("openai-codex")
				return grpcHandled(grpcResponse(requestId, createUnauthenticatedAccountState(), false))

			case "AccountService.openrouterAuthClicked":
				return grpcHandled(grpcResponse(requestId, await this.handleAccountAuthAction("openrouter", message), false))

			case "AccountService.requestyAuthClicked":
				return grpcHandled(grpcResponse(requestId, await this.handleAccountAuthAction("requesty", message), false))

			case "AccountService.hicapAuthClicked":
				return grpcHandled(grpcResponse(requestId, await this.handleAccountAuthAction("hicap", message), false))

			case "AccountService.openAiCodexSignIn":
				this.state.openAiCodexIsAuthenticated = false
				await this.broadcastState()
				return grpcHandled(grpcResponse(requestId, await this.handleAccountAuthAction("openAiCodex", message), false))

			case "AccountService.openAiCodexSignOut":
				this.state.openAiCodexIsAuthenticated = false
				await this.clearOAuthCredential("openai-codex")
				return grpcHandled(grpcResponse(requestId, createUnauthenticatedAccountState(), false), ...this.buildStateMessages())

			case "AccountService.saveProviderCredential":
			case "AccountService.storeProviderCredential":
			case "AccountService.saveProviderToken":
				return grpcHandled(grpcResponse(requestId, await this.saveProviderCredential(message), false), ...this.buildStateMessages())

			case "AccountService.getProviderCredentialStatus":
			case "AccountService.getProviderAuthStatus":
				return grpcHandled(grpcResponse(requestId, this.getProviderCredentialStatus(message), false))

			case "AccountService.refreshProviderCredential":
			case "AccountService.refreshProviderToken":
			case "AccountService.refreshOAuthCredential":
				return grpcHandled(grpcResponse(requestId, await this.refreshOAuthCredential(message), false), ...this.buildStateMessages())

			case "AccountService.getProviderConfigFields":
			case "AccountService.getProviderAuthRequirements":
				return grpcHandled(grpcResponse(requestId, await this.getProviderConfigFields(message), false))

			case "AccountService.getOAuthCallbackStatus":
			case "AccountService.getProviderOAuthCallbackStatus":
				return grpcHandled(grpcResponse(requestId, this.getOAuthCallbackStatus(message), false))

			case "AccountService.submitOAuthCallback":
			case "AccountService.completeOAuthCallback":
			case "AccountService.saveOAuthCallback":
				return grpcHandled(grpcResponse(requestId, await this.submitOAuthCallback(message), false), ...this.buildStateMessages())

			case "AccountService.clearProviderCredential":
			case "AccountService.deleteProviderCredential":
			case "AccountService.clearProviderToken":
				return grpcHandled(grpcResponse(requestId, await this.clearProviderCredential(message), false), ...this.buildStateMessages())

			case "OcaAccountService.ocaAccountLoginClicked":
				return grpcHandled(grpcResponse(requestId, await this.handleAccountAuthAction("oca", message), false))

			case "OcaAccountService.ocaAccountLogoutClicked":
				return grpcHandled(grpcResponse(requestId, createUnauthenticatedAccountState(), false))

			case "BrowserService.getDetectedChromePath": {
				return grpcHandled(grpcResponse(requestId, this.requireBrowserHandler().getDetectedPath(this.getBrowserSettings()), false))
			}

			case "BrowserService.getBrowserConnectionInfo":
				return grpcHandled(grpcResponse(requestId, await this.requireBrowserHandler().getConnectionInfo(this.getBrowserSettings()), false))

			case "BrowserService.testBrowserConnection": {
				const hostValue = getString(message, "value") || getString(message, "host") || getString(message, "url")
				return grpcHandled(grpcResponse(requestId, await this.requireBrowserHandler().testConnection(hostValue, this.getBrowserSettings()), false))
			}

			case "BrowserService.discoverBrowser":
				return grpcHandled(grpcResponse(requestId, await this.requireBrowserHandler().discover(this.getBrowserSettings()), false))

			case "BrowserService.relaunchChromeDebugMode": {
				const browserSettings = asRecord(this.state.browserSettings)
				const host = getString(browserSettings, "remoteBrowserHost") || "http://localhost:9222"
				return grpcHandled(
					grpcResponse(
						requestId,
						{
							success: false,
							value:
								"Automatic Chrome relaunch is not implemented in the Visual Studio host yet. " +
								`Launch Chrome or Edge manually with remote debugging enabled, for example: chrome.exe --remote-debugging-port=9222, then reconnect to ${host}.`,
							message:
								"Automatic Chrome relaunch is not implemented in the Visual Studio host yet. " +
								`Launch Chrome or Edge manually with remote debugging enabled, then reconnect to ${host}.`,
						},
						false,
					),
				)
			}

			case "BrowserService.listBrowserTabs":
				return grpcHandled(grpcResponse(requestId, await this.requireBrowserHandler().listTabs(this.getBrowserSettings()), false))

			case "BrowserService.captureScreenshot":
				return grpcHandled(grpcResponse(requestId, await this.requireBrowserHandler().captureScreenshot(message, this.getBrowserSettings()), false))

			case "BrowserService.performBrowserAction":
			case "BrowserService.executeBrowserAction":
				return grpcHandled(grpcResponse(requestId, await this.requireBrowserHandler().performAction(message, this.getBrowserSettings()), false))

			case "StateService.getAvailableTerminalProfiles":
				return grpcHandled(
					grpcResponse(
						requestId,
						{
							profiles: [
								{
									id: "visual-studio-command-host",
									name: "Visual Studio Command Host",
								},
							],
						},
						false,
					),
				)

			case "TerminalService.openTerminalPanel":
			case "UiService.openTerminalPanel":
				return grpcHandled(grpcResponse(requestId, await host.workspaceClient.openTerminalPanel(asRecord(message)), false))

			case "TerminalService.attachTerminalCommand":
			case "UiService.attachTerminalCommand":
				return grpcHandled(
					grpcResponse(requestId, await host.workspaceClient.attachTerminalCommand(asRecord(message)), false),
					...this.buildStateMessages(),
				)

			case "TerminalService.continueTerminalCommand":
			case "UiService.continueTerminalCommand":
				return grpcHandled(
					grpcResponse(requestId, await host.workspaceClient.continueTerminalCommand(asRecord(message)), false),
					...this.buildStateMessages(),
				)

			case "StateService.updateSettings":
			case "StateService.updateAutoApprovalSettings":
			case "ModelsService.updateApiConfigurationProto":
			case "ModelsService.updateApiConfiguration":
				this.applySettings(message)
				this.stateStore.save(createPersistedStateSnapshot(this.state))
				return grpcHandled(grpcResponse(requestId, {}, false), ...this.buildStateMessages())

			case "StateService.togglePlanActModeProto":
				this.state.mode = resolveRequestedPlanActMode(message, this.state.mode)
				this.stateStore.save(createPersistedStateSnapshot(this.state))
				await this.broadcastState()
				return grpcHandled(grpcResponse(requestId, { value: true, mode: this.state.mode }, false))

			case "StateService.updateTelemetrySetting":
				this.state.telemetrySetting = getString(message, "value") || getString(message, "telemetrySetting") || this.state.telemetrySetting
				await this.broadcastState()
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "StateService.dismissBanner":
				this.applyBannerDismissal(message)
				await this.broadcastState()
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "StateService.updateInfoBannerVersion":
				this.state.lastDismissedInfoBannerVersion = getNumber(message, "value") || getNumber(message, "version") || this.state.lastDismissedInfoBannerVersion
				await this.broadcastState()
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "StateService.updateModelBannerVersion":
				this.state.lastDismissedModelBannerVersion = getNumber(message, "value") || getNumber(message, "version") || this.state.lastDismissedModelBannerVersion
				await this.broadcastState()
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "StateService.updateCliBannerVersion":
				this.state.lastDismissedCliBannerVersion = getNumber(message, "value") || getNumber(message, "version") || this.state.lastDismissedCliBannerVersion
				await this.broadcastState()
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "StateService.updateTerminalConnectionTimeout":
				this.state.shellIntegrationTimeout = getNumber(message, "value") || getNumber(message, "timeout") || this.state.shellIntegrationTimeout
				await this.broadcastState()
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "StateService.setWelcomeViewCompleted":
				this.state.welcomeViewCompleted = true
				this.state.isNewUser = false
				await this.broadcastState()
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "StateService.captureOnboardingProgress":
			case "StateService.refreshRemoteConfig":
			case "StateService.testOtelConnection":
			case "StateService.testPromptUploading":
			case "StateService.installClineCli":
				return grpcHandled(grpcResponse(requestId, { value: false }, false))

			case "StateService.toggleFavoriteModel":
				this.toggleFavoriteModel(getString(message, "value") || getString(message, "modelId"))
				await this.broadcastState()
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "StateService.resetState":
				this.stateStore.clear()
				Object.assign(this.state, createInitialState())
				await this.clearTask()
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "TaskService.clearTask":
				await this.clearTask()
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "TaskService.newTask":
				if (this.pendingQuestion) {
					await this.sendAskResponse(message, requestId)
					return grpcHandled(grpcResponse(requestId, {}, false), ...this.buildStateMessages())
				}
				if (this.state.currentTaskItem && getString(message, "text").trim()) {
					await this.sendAskResponse(message, requestId)
					return grpcHandled(grpcResponse(requestId, {}, false), ...this.buildStateMessages())
				}
				await this.startNewTask(message, { broadcast: true, requestId })
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "TaskService.askResponse":
				await this.sendAskResponse(message, requestId)
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "SlashService.condense":
				await this.compactCurrentSession(requestId)
				return grpcHandled(grpcResponse(requestId, {}, false), ...this.buildStateMessages())

			case "TaskService.cancelTask":
				await this.cancelTask()
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "TaskService.getTaskHistory":
				this.taskHistorySync.refreshInBackground("getTaskHistory")
				return grpcHandled(grpcResponse(requestId, { tasks: this.state.taskHistory }, false))

			case "TaskService.getTotalTasksSize":
				this.taskHistorySync.refreshInBackground("getTotalTasksSize")
				return grpcHandled(grpcResponse(requestId, { value: this.state.taskHistory.length }, false))

			case "TaskService.showTaskWithId":
				await this.showTaskWithId(getString(message, "value") || getString(message, "taskId"))
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "TaskService.deleteTasksWithIds":
				await this.taskHistoryCommands.delete(getStringArray(message, "value"))
				await this.broadcastState()
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "TaskService.deleteAllTaskHistory":
				await this.taskHistoryCommands.deleteAll()
				await this.broadcastState()
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "CheckpointsService.checkpointRestore":
				await this.restoreCheckpoint(message)
				return grpcHandled(grpcResponse(requestId, { value: true }, false))

			case "CheckpointsService.checkpointDiff":
				return grpcHandled(grpcResponse(requestId, await this.describeCheckpointDiff(message), false), ...this.buildStateMessages())

			case "FileService.refreshRules":
				return grpcHandled(grpcResponse(requestId, await this.refreshSdkInstructionSettings(), false))

			case "FileService.refreshSkills":
				return grpcHandled(grpcResponse(requestId, await this.refreshSdkSkills(), false))

			case "FileService.toggleClineRule":
				await this.toggleSdkSetting("rules", message)
				return grpcHandled(grpcResponse(requestId, await this.refreshSdkInstructionSettings(), false))

			case "FileService.toggleCursorRule":
			case "FileService.toggleWindsurfRule":
			case "FileService.toggleAgentsRule":
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "FileService.toggleWorkflow":
				await this.toggleSdkSetting("workflows", message)
				return grpcHandled(grpcResponse(requestId, await this.refreshSdkInstructionSettings(), false))

			case "FileService.toggleSkill":
				await this.toggleSdkSetting("skills", message)
				return grpcHandled(grpcResponse(requestId, await this.refreshSdkSkills(), false))

			case "FileService.refreshHooks":
				return grpcHandled(grpcResponse(requestId, await this.refreshHookSettings(), false))

			case "FileService.createHook":
				return grpcHandled(grpcResponse(requestId, await this.createHook(message), false))

			case "FileService.deleteHook":
				return grpcHandled(grpcResponse(requestId, await this.deleteHook(message), false))

			case "FileService.toggleHook":
				return grpcHandled(grpcResponse(requestId, await this.toggleHook(message), false))

			case "ScheduledAgentsService.listSpecs":
			case "ScheduledAgentsService.listScheduledAgents":
			case "AutomationService.listScheduledAgents":
				return grpcHandled(grpcResponse(requestId, await this.listScheduledAgentSpecs(), false))

			case "ScheduledAgentsService.createSpec":
			case "ScheduledAgentsService.updateSpec":
			case "ScheduledAgentsService.saveSpec":
			case "AutomationService.saveScheduledAgent":
				return grpcHandled(grpcResponse(requestId, await this.saveScheduledAgentSpec(message), false))

			case "ScheduledAgentsService.deleteSpec":
			case "ScheduledAgentsService.deleteScheduledAgent":
			case "AutomationService.deleteScheduledAgent":
				return grpcHandled(grpcResponse(requestId, await this.deleteScheduledAgentSpec(message), false))

			case "ScheduledAgentsService.runSpec":
			case "ScheduledAgentsService.runScheduledAgent":
			case "AutomationService.runScheduledAgent":
				return grpcHandled(grpcResponse(requestId, await this.runScheduledAgentSpec(message), false), ...this.buildStateMessages())

			case "PluginService.listPlugins":
			case "PluginService.getPluginConfigStatus":
			case "PluginsService.listPlugins":
			case "PluginsService.getPluginConfigStatus":
				return grpcHandled(grpcResponse(requestId, await this.getLocalPluginConfigStatus(), false))

			case "FileService.createRuleFile":
			case "FileService.deleteRuleFile":
			case "FileService.createSkillFile":
			case "FileService.deleteSkillFile":
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "FileService.openVsClineDiff": {
				const leftPath = getString(message, "leftPath") || getString(message, "beforePath")
				const rightPath = getString(message, "rightPath") || getString(message, "afterPath") || getString(message, "filePath")
				const title = getString(message, "title") || (rightPath ? `LIG VS change: ${path.basename(rightPath)}` : "LIG VS change")
				if (leftPath && rightPath) {
					await this.host.diffClient.openDiff({ leftPath, rightPath, title })
				} else if (rightPath) {
					await this.host.windowClient.openFile({ filePath: rightPath })
				}
				return grpcHandled(grpcResponse(requestId, {}, false))
			}

			case "FileService.revertVsClineChanges":
				return grpcHandled(grpcResponse(requestId, await this.revertVsClineChanges(message), false), ...this.buildStateMessages())

			case "FileService.copyToClipboard":
				await this.host.envClient.clipboardWriteText({
					value: getString(message, "value") || getString(message, "text"),
				})
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "FileService.ifFileExistsRelativePath": {
				const relativePath = getString(message, "value") || getString(message, "path") || getString(message, "relativePath")
				const workspaceRoot = await this.getPrimaryWorkspaceRoot()
				const fullPath = workspaceRoot && relativePath ? path.resolve(workspaceRoot, relativePath) : ""
				const exists = fullPath ? fs.existsSync(fullPath) : false
				return grpcHandled(grpcResponse(requestId, { value: exists }, false))
			}

			case "FileService.getRelativePaths":
				return grpcHandled(grpcResponse(requestId, { values: [], paths: [] }, false))

			case "FileService.searchFiles":
			case "FileService.searchCommits":
				return grpcHandled(grpcResponse(requestId, { results: [], values: [] }, false))

			case "FileService.selectFiles": {
				try {
					const selected = asRecord(await host.workspaceClient.selectFiles({
						allowImages: getBoolean(message, "value") || getBoolean(message, "allowImages"),
					}))
					return grpcHandled(
						grpcResponse(
							requestId,
							{
								values1: Array.isArray(selected.values1) ? selected.values1 : selected.images || [],
								values2: Array.isArray(selected.values2) ? selected.values2 : selected.files || [],
							},
							false,
						),
					)
				} catch (error) {
					await host.windowClient.showMessage({
						message: `LIG VS could not open the file picker: ${stringify(error)}`,
						type: "warning",
					})
					return grpcHandled(grpcResponse(requestId, { values1: [], values2: [], error: stringify(error) }, false))
				}
			}

			case "FileService.openMention":
			case "FileService.openDiskConversationHistory":
			case "FileService.openFocusChainFile":
			case "FileService.openImage":
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "FileService.openFile":
			case "FileService.openFileRelativePath": {
				const filePath =
					getString(message, "filePath") ||
					getString(message, "path") ||
					getString(message, "value") ||
					getString(message, "relativePath")
				const workspaceRoot = await this.getPrimaryWorkspaceRoot()
				const fullPath = path.isAbsolute(filePath) ? filePath : workspaceRoot ? path.resolve(workspaceRoot, filePath) : filePath
				if (fullPath) {
					await host.windowClient.openFile({ filePath: fullPath, line: getNumber(message, "line") })
				}
				return grpcHandled(grpcResponse(requestId, {}, false))
			}

			case "ModelsService.getOllamaModels": {
				const values = await getOllamaModels(getString(message, "value"))
				if (values.length > 0) {
					this.applyDefaultOllamaModel(values[0])
				}
				return grpcHandled(grpcResponse(requestId, { values }, false))
			}

			case "ModelsService.getLmStudioModels":
				return grpcHandled(grpcResponse(requestId, await this.createProviderModelCatalog("lmstudio", asRecord(message)), false))

			case "ModelsService.getAskSageModels":
				return grpcHandled(grpcResponse(requestId, await this.requireProviderModelCatalogs().askSageModels(getString(message, "baseUrl")), false))

			case "ModelsService.getOpenRouterKeyInfo":
				return grpcHandled(grpcResponse(requestId, await this.requireProviderModelCatalogs().openRouterKeyInfo(getString(message, "apiKey")), false))

			case "ModelsService.refreshOpenAiModels":
				return grpcHandled(grpcResponse(requestId, await this.createProviderModelCatalog("openai-compatible", asRecord(message)), false))

			case "ModelsService.refreshLiteLlmModelsRpc":
				return grpcHandled(grpcResponse(requestId, await this.createProviderModelCatalog("litellm", asRecord(message)), false))

			case "ModelsService.refreshOpenRouterModelsRpc":
				return grpcHandled(grpcResponse(requestId, await this.createProviderModelCatalog("openrouter", asRecord(message)), false))

			case "ModelsService.refreshRequestyModels":
				return grpcHandled(grpcResponse(requestId, await this.createProviderModelCatalog("requesty", asRecord(message)), false))

			case "ModelsService.refreshGroqModelsRpc":
				return grpcHandled(grpcResponse(requestId, await this.createProviderModelCatalog("groq", asRecord(message)), false))

			case "ModelsService.refreshVercelAiGatewayModelsRpc":
				return grpcHandled(grpcResponse(requestId, await this.createProviderModelCatalog("vercel-ai-gateway", asRecord(message)), false))

			case "ModelsService.refreshHicapModels":
				return grpcHandled(grpcResponse(requestId, await this.createProviderModelCatalog("hicap", asRecord(message)), false))

			case "ModelsService.getAihubmixModels":
				return grpcHandled(grpcResponse(requestId, await this.createProviderModelCatalog("aihubmix", asRecord(message)), false))

			case "ModelsService.refreshOcaModels":
				return grpcHandled(grpcResponse(requestId, await this.createProviderModelCatalog("oca", asRecord(message)), false))

			case "ModelsService.refreshBasetenModelsRpc":
				return grpcHandled(grpcResponse(requestId, await this.createProviderModelCatalog("baseten", asRecord(message)), false))

			case "ModelsService.refreshHuggingFaceModels":
				return grpcHandled(grpcResponse(requestId, await this.createProviderModelCatalog("huggingface", asRecord(message)), false))

			case "ModelsService.getSapAiCoreModels":
				return grpcHandled(grpcResponse(requestId, await this.createProviderModelCatalog("sapaicore", asRecord(message)), false))

			case "ModelsService.getVsCodeLmModels":
			case "ModelsService.refreshClineModelsRpc":
			case "ModelsService.refreshClineRecommendedModelsRpc":
				return grpcHandled(grpcResponse(requestId, this.createUnsupportedModelCatalog(key), false))

			case "WorktreeService.listWorktrees":
				return grpcHandled(grpcResponse(requestId, await this.listWorktrees(), false))

			case "WorktreeService.getWorktreeDefaults":
				return grpcHandled(grpcResponse(requestId, await this.getWorktreeDefaults(), false))

			case "WorktreeService.getWorktreeIncludeStatus":
				return grpcHandled(grpcResponse(requestId, await this.getWorktreeIncludeStatus(), false))

			case "WorktreeService.createWorktreeInclude":
				return grpcHandled(grpcResponse(requestId, await this.createWorktreeInclude(message), false))

			case "WorktreeService.createWorktree":
				return grpcHandled(grpcResponse(requestId, await this.requireWorktreeMutations().create(message, await this.getPrimaryWorkspaceRoot()), false))

			case "WorktreeService.switchWorktree":
				return grpcHandled(grpcResponse(requestId, await this.requireWorktreeMutations().switch(message), false))

			case "WorktreeService.mergeWorktree":
				return grpcHandled(grpcResponse(requestId, await this.requireWorktreeMutations().merge(message, await this.getPrimaryWorkspaceRoot()), false))

			case "WorktreeService.recoverMerge":
			case "WorktreeService.mergeRecovery":
				return grpcHandled(grpcResponse(requestId, await this.requireWorktreeMutations().recover(message), false))

			case "WorktreeService.deleteWorktree":
				return grpcHandled(grpcResponse(requestId, await this.requireWorktreeMutations().delete(message, await this.getPrimaryWorkspaceRoot()), false))

			case "WorktreeService.trackWorktreeViewOpened":
				return grpcHandled(grpcResponse(requestId, { success: true }, false))

			case "McpService.getLatestMcpServers":
				return grpcHandled(grpcResponse(requestId, await this.getMcpServersResponse(), false))

			case "McpService.refreshMcpMarketplace":
				return grpcHandled(grpcResponse(requestId, this.getMcpMarketplaceResponse(), false))

			case "McpService.addRemoteMcpServer":
				return this.grpcMcpServersMutation(requestId, await this.requireMcp().mutate("addRemoteServer", asRecord(message)))

			case "McpService.openMcpSettings":
				await this.openMcpSettingsFile()
				return grpcHandled(grpcResponse(requestId, {}, false))

			case "McpService.updateMcpTimeout":
				return this.grpcMcpServersMutation(requestId, await this.requireMcp().mutate("updateTimeout", asRecord(message)))

			case "McpService.restartMcpServer":
				return this.grpcMcpServersMutation(requestId, await this.requireMcp().mutate("restartServer", asRecord(message)))

			case "McpService.deleteMcpServer":
				return this.grpcMcpServersMutation(requestId, await this.requireMcp().mutate("deleteServer", asRecord(message)))

			case "McpService.toggleToolAutoApprove":
				return this.grpcMcpServersMutation(requestId, await this.requireMcp().mutate("toggleToolAutoApprove", asRecord(message)))

			case "McpService.toggleMcpServer":
				return this.grpcMcpServersMutation(requestId, await this.requireMcp().mutate("toggleServer", asRecord(message)))

			case "McpService.authenticateMcpServer":
				return this.grpcMcpServersMutation(requestId, await this.requireMcp().mutate("authenticateServer", asRecord(message)))

			case "McpService.downloadMcp":
				return grpcHandled(
					grpcError(
						requestId,
						"MCP marketplace installation is not implemented in the Visual Studio port yet. Add stdio/SSE/streamable HTTP servers from the MCP configuration file or Add Server tab.",
						false,
					),
				)

			case "TaskService.toggleTaskFavorite":
				this.taskHistoryCommands.toggleFavorite(getString(message, "taskId"), asRecord(message).isFavorited === true)
				await this.broadcastState()
				return grpcHandled(grpcResponse(requestId, {}, false))

			default:
				return null
		}
	}

	private disposeStreamRequest(requestId: string) {
		return this.requireStreamPublisher().unsubscribe(requestId) || this.mcpServerStreamRequestIds.delete(requestId)
	}

	private logSlowGrpcRequest(key: string, startedAt: number, streaming: boolean) {
		const durationMs = Date.now() - startedAt
		const thresholdMs = readPositiveIntEnv("VSCLINE_SLOW_WEBVIEW_RPC_MS", 750)
		if (durationMs >= thresholdMs) {
			this.logger.log("sidecar", "webviewRpcSlow", { key, streaming, durationMs, thresholdMs })
		}
	}

	private async handleAccountAuthAction(provider: string, message: unknown = {}) {
		const request = asRecord(message)
		const credential = extractProviderCredentialValue(request)
		if (credential) {
			return this.saveProviderCredential({ ...request, provider, value: credential, source: "auth_action" })
		}

		const bridge = isOAuthBridgeProvider(provider) ? await this.requireOAuthAuthorization().ensure(provider, request, (url) => this.handleOAuthCallbackUrl(url)) : null
		const response = await this.requireProviderAuthActions().execute(provider, message, bridge)
		if (provider === "openAiCodex") {
			this.state.openAiCodexIsAuthenticated = false
			await this.broadcastState()
		}
		return response
	}

	private async createOAuthCallbackBridgeResponse(message: unknown, fallbackProvider: string) {
		const request = asRecord(message)
		const provider = normalizeProviderValue(getString(request, "provider") || getString(request, "providerId") || fallbackProvider)
		const bridge = await this.requireOAuthAuthorization().ensure(provider || fallbackProvider, request, (url) => this.handleOAuthCallbackUrl(url))
		return this.requireOAuthAuthorization().response(bridge)
	}

	private async handleOAuthCallbackUrl(url: string) {
		const result = await this.requireOAuthCallbackHandler().receive(url, (mutation) => this.applyProviderCredentialMutation(mutation))
		await this.broadcastState().catch((error) => console.error(error))
		return result
	}

	private async clearOAuthCredential(provider: string) {
		return this.applyProviderCredentialMutation(this.requireProviderCredentials().clear({ provider }))
	}

	private getOAuthCallbackStatus(message: unknown) {
		return this.requireOAuthCallbackHandler().status(message)
	}

	private async submitOAuthCallback(message: unknown) {
		return this.requireOAuthCallbackHandler().submit(message, (mutation) => this.applyProviderCredentialMutation(mutation))
	}

	private async saveProviderCredential(message: unknown) {
		return this.applyProviderCredentialMutation(this.requireProviderCredentials().save(message))
	}

	private getProviderCredentialStatus(message: unknown) {
		return this.requireProviderCredentials().status(message, asRecord(this.state.apiConfiguration))
	}

	private async refreshOAuthCredential(message: unknown) {
		return this.applyProviderCredentialMutation(await this.requireProviderCredentials().refresh(message, asRecord(this.state.apiConfiguration)))
	}

	private async getProviderConfigFields(message: unknown) {
		return this.requireProviderCredentials().getConfigFields(message, asRecord(this.state.apiConfiguration))
	}

	private async clearProviderCredential(message: unknown) {
		return this.applyProviderCredentialMutation(this.requireProviderCredentials().clear(message))
	}

	private async applyProviderCredentialMutation(mutation: ProviderCredentialMutation) {
		if (mutation.updates || mutation.deletes?.length || mutation.openAiCodexAuthenticated !== undefined) {
			const next = { ...asRecord(this.state.apiConfiguration), ...mutation.updates }
			for (const field of mutation.deletes || []) delete next[field]
			this.state.apiConfiguration = normalizeApiConfiguration(next) as typeof this.state.apiConfiguration
			if (mutation.openAiCodexAuthenticated !== undefined) this.state.openAiCodexIsAuthenticated = mutation.openAiCodexAuthenticated
			this.apiConfigurationProfiles.syncActive()
			this.stateStore.save(createPersistedStateSnapshot(this.state))
			await this.broadcastState()
		}
		if (mutation.log) this.logger.log("sidecar", mutation.log.event, { ...mutation.log.details })
		return { ...mutation.response }
	}

	private async getPrimaryWorkspaceRoot() {
		const workspaceRoots = await this.host.workspaceClient.getWorkspacePaths({}).catch(() => [])
		return workspaceRoots[0] || String(this.state.currentTaskItem?.cwdOnTaskInitialization || process.cwd())
	}

	private async listWorktrees() {
		const result = await this.requireWorktreeQueries().listWorktrees(await this.getPrimaryWorkspaceRoot())
		this.setWorktreesFeatureFlag(result.isGitRepo && !result.error)
		return result
	}

	private setWorktreesFeatureFlag(enabled: boolean) {
		const current = asRecord(this.state.worktreesEnabled)
		this.state.worktreesEnabled = {
			...current,
			user: current.user !== false,
			featureFlag: enabled,
		}
	}

	private async getWorktreeDefaults() {
		return this.requireWorktreeQueries().getDefaults(await this.getPrimaryWorkspaceRoot())
	}

	private async getWorktreeIncludeStatus() {
		return this.requireWorktreeQueries().getIncludeStatus(await this.getPrimaryWorkspaceRoot())
	}

	private async createWorktreeInclude(message: unknown) {
		return this.requireWorktreeQueries().createInclude(getString(message, "content"), await this.getPrimaryWorkspaceRoot())
	}

	private requireClineSdk() {
		if (!this.clineSdk) {
			throw new Error("LIG VS SDK runtime is not attached.")
		}
		return this.clineSdk
	}

	private async getMcpServersResponse() {
		return this.requireMcp().listServers()
	}

	private requireMcp() {
		if (!this.mcp) {
			throw new Error("LIG VS MCP application service is not attached.")
		}
		return this.mcp
	}

	private grpcMcpServersMutation(requestId: string, response: unknown) {
		// MCP tools are fixed when an SDK session starts. Restart the session on the
		// next user turn so the model receives the updated tool schemas.
		this.runtimeSettingsRevision++
		return grpcHandled(
			grpcResponse(requestId, response, false),
			...this.buildMcpServerStreamMessages(response),
		)
	}

	private buildMcpServerStreamMessages(response: unknown) {
		return [...this.mcpServerStreamRequestIds]
			.filter((streamRequestId) => streamRequestId)
			.map((streamRequestId) => grpcResponse(streamRequestId, response, true))
	}

	private getMcpMarketplaceResponse() {
		const catalog = { items: [] }
		return { catalog, items: catalog.items }
	}

	private async openMcpSettingsFile() {
		const filePath = await this.requireMcp().getSettingsPath()
		await this.host.windowClient.openFile({ filePath })
	}

	private clearLiveInteractionState(reason: string) {
		const hadState =
			this.approvals.hasPending ||
			!!this.pendingQuestion ||
			this.conversationProjection.hasActiveInteraction ||
			this.terminalActivity?.isActive === true

		this.clearTaskIdleWatchdog()
		this.clearPartialIdleWatchdog()
		this.clearPartialStateBroadcastTimer()
		this.stopTerminalStatePolling()
		this.approvals.clear({ approved: false, reason: `Cleared by ${reason}.` })
		this.pendingQuestion?.resolve("")
		this.pendingQuestion = null
		this.conversationProjection.clearActiveInteraction()

		if (hadState) {
			this.logger.log("sidecar", "clearedLiveInteractionState", { reason })
		}
	}

	private async startNewTask(message: unknown, options: { broadcast?: boolean; requestId?: string } = {}) {
		if (!this.clineSdk) {
			throw new Error("LIG VS SDK runtime is not attached.")
		}
		this.transitionTask("starting", "start-new-task")

		const text = getString(message, "text")
		const images = getStringArray(message, "images")
		const files = getStringArray(message, "files")
		const requestedWorkspacePath = getString(message, "workspacePath") || getString(message, "cwd") || getString(message, "worktreePath")
		const initialCwd = requestedWorkspacePath && fs.existsSync(requestedWorkspacePath)
			? path.resolve(requestedWorkspacePath)
			: process.cwd()
		const taskItem = createHistoryItem(createId(), text, initialCwd, this.getModelId())
		this.startSendLatencyTrace(options.requestId || createId(), "newTask", String(taskItem.id || ""), text.length)
		if (requestedWorkspacePath) {
			;(taskItem as Record<string, unknown>).workspacePath = initialCwd
			;(taskItem as Record<string, unknown>).worktreePath = initialCwd
		}

		this.state.clineMessages = []
		this.conversationProjection.beginTask()
		this.state.currentTaskItem = taskItem
		this.state.taskHistory = upsertTaskHistoryItem(this.state.taskHistory, taskItem)
		this.addMessage({ type: "say", say: "task", text, images, files })
		this.upsertFoldedReasoningText(this.state.uiLanguage === "en" ? "Preparing response." : "응답을 준비하는 중입니다.")
		this.noteTaskActivity("start")
		this.updateCurrentTaskItem()
		this.schedulePersistedStateSave()
		if (options.broadcast !== false) {
			this.broadcastState().catch((error) => console.error(error))
		}

		void this.prepareAndLaunchNewTask({
			text,
			images,
			files,
			requestedWorkspacePath,
			initialCwd,
			taskItem,
		})
	}

	private async prepareAndLaunchNewTask({
		text,
		images,
		files,
		requestedWorkspacePath,
		initialCwd,
		taskItem,
	}: {
		text: string
		images: string[]
		files: string[]
		requestedWorkspacePath: string
		initialCwd: string
		taskItem: Record<string, unknown>
	}) {
		if (!this.clineSdk) {
			return
		}

		let cwd = initialCwd
		try {
			const workspaceRoots = await this.host.workspaceClient.getWorkspacePaths({})
			cwd = requestedWorkspacePath && fs.existsSync(requestedWorkspacePath)
				? path.resolve(requestedWorkspacePath)
				: workspaceRoots[0] || initialCwd
			taskItem.cwdOnTaskInitialization = cwd
			if (requestedWorkspacePath) {
				taskItem.workspacePath = cwd
				taskItem.worktreePath = cwd
			}
			this.updateCurrentTaskItem()
			this.sendPartialMessage(this.state.clineMessages.find((message) => message.ts === this.conversationProjection.activeReasoningTextTs))
			const previousActiveSessionId = this.clineSdk.status.activeSessionId
			if (previousActiveSessionId) {
				this.closingSessionIds.add(previousActiveSessionId)
				await this.clineSdk.stop({ sessionId: previousActiveSessionId }).catch((error) => {
					this.logger.log("sidecar", "startNewTask.stopPreviousFailed", {
						sessionId: previousActiveSessionId,
						error: error instanceof Error ? error.message : String(error),
					})
				})
			}
			void this.runLifecycleHooks("TaskStart", { prompt: text, cwd, files, images, sessionId: String(taskItem.id || "") })
			void this.runLifecycleHooks("UserPromptSubmit", { prompt: text, cwd, files, images, sessionId: String(taskItem.id || "") })
			await this.launchSdkStartSession({
				prompt: text,
				cwd,
				userImages: await normalizeSdkImageInputs(images),
				userFiles: files,
				interactive: true,
			}, cwd, String(taskItem.id || ""), "startSession")
		} catch (error) {
			this.clearTaskIdleWatchdog()
			this.addMessage({ type: "say", say: "error", text: error instanceof Error ? error.message : String(error) })
			this.updateCurrentTaskItem()
			await this.broadcastState()
		}
	}

	private async launchSdkStartSession(
		params: StartTaskCommand,
		cwd: string,
		sessionId: string,
		source: string,
	) {
		if (!this.clineSdk) {
			return
		}

		let runGeneration = 0
		try {
			const config = await this.buildSdkConfig(cwd, sessionId)
			this.markSendLatencySdkSend(sessionId)
			runGeneration = ++this.sdkRunGeneration
			if (!this.startTaskHandler) throw new Error("StartTaskHandler is not attached.")
			const result = await this.startTaskHandler.execute({
				...params,
				config,
				toolPolicies: this.createCurrentToolPolicies(),
			})
			this.activeSessionRuntimeSettingsRevision = this.runtimeSettingsRevision
			await this.completeFromSdkResult(result, sessionId, source, runGeneration)
		} catch (error) {
			if (runGeneration && runGeneration !== this.sdkRunGeneration) {
				this.logger.log("sidecar", "ignoredSupersededSdkError", {
					source,
					sessionId,
					runGeneration,
					currentRunGeneration: this.sdkRunGeneration,
					error: error instanceof Error ? error.message : String(error),
				})
				return
			}
			await this.recoverFromSdkRunError(sessionId, source, runGeneration, error)
		}
	}

	private async sendAskResponse(message: unknown, requestId = createId()) {
		if (!this.clineSdk) {
			throw new Error("LIG VS SDK runtime is not attached.")
		}

		const responseType = getString(message, "responseType")
		const text = buildTaskInputWithAttachments(getString(message, "text"), getStringArray(message, "images"), getStringArray(message, "files"))
		const activeSessionId = this.clineSdk.status.activeSessionId
		const selectedSessionId = String(this.state.currentTaskItem?.id || "")
		this.logger.log("sidecar", "sendAskResponse.received", {
			responseType,
			textLength: text.length,
			hasPendingApproval: this.approvals.hasPending,
			hasPendingQuestion: !!this.pendingQuestion,
			activeSessionId,
			selectedSessionId,
		})

		if (this.approvals.hasPending && activeSessionId) {
			this.transitionTask("streaming", "approval-response")
			const approved = responseType === "yesButtonClicked"
			const feedback = text
			const pending = this.approvals.take()
			this.logger.log("sidecar", "sendAskResponse.pendingApproval", { approved, activeSessionId })
			this.addMessage({
				type: "say",
				say: "user_feedback",
				text: feedback.trim() || (approved ? "승인됨" : "거부됨"),
				images: getStringArray(message, "images"),
				files: getStringArray(message, "files"),
			})
			this.updateCurrentTaskItem()
			await this.broadcastState()
			pending?.({ approved, reason: feedback.trim() || (approved ? "Visual Studio에서 승인됨." : "Visual Studio에서 거부됨.") })
			return
		}

		if (this.pendingQuestion && activeSessionId) {
			this.transitionTask("streaming", "question-response")
			const answer = getAskResponseText(message)
			const answerText = buildTaskInputWithAttachments(answer, getStringArray(message, "images"), getStringArray(message, "files"))
			const pending = this.pendingQuestion
			this.pendingQuestion = null
			this.logger.log("sidecar", "sendAskResponse.pendingQuestion", { activeSessionId, answerLength: answerText.length })
			this.removeAskMessages("followup")
			this.addMessage({
				type: "say",
				say: "user_feedback",
				text: answerText.trim() || "No response.",
				images: getStringArray(message, "images"),
				files: getStringArray(message, "files"),
			})
			this.updateCurrentTaskItem()
			await this.broadcastState()
			pending.resolve(answerText.trim())
			return
		}

		if (!text.trim()) {
			return
		}

		if (this.approvals.hasPending || this.pendingQuestion) {
			this.logger.log("sidecar", "sendAskResponse.stalePendingIgnored", {
				hasPendingApproval: this.approvals.hasPending,
				hasPendingQuestion: !!this.pendingQuestion,
				activeSessionId,
				selectedSessionId,
			})
			this.approvals.clear({ approved: false, reason: "Superseded by resumed chat message." })
			this.pendingQuestion?.resolve("")
			this.pendingQuestion = null
		}

		const sessionId = activeSessionId || selectedSessionId
		if (!sessionId) {
			this.logger.log("sidecar", "sendAskResponse.startNewTask", { textLength: text.length })
			await this.startNewTask(
				{
					text: getString(message, "text"),
					images: getStringArray(message, "images"),
					files: getStringArray(message, "files"),
				},
				{ broadcast: true, requestId },
			)
			return
		}
		this.startSendLatencyTrace(requestId, "askResponse", sessionId, text.length)
		this.transitionTask("starting", "send-response")

		this.removeTerminalAskMessages()
		const userMessage = this.addMessage({ type: "say", say: "user_feedback", text })
		this.foldedProgressProjector.beginReasoning()
		this.upsertFoldedReasoningText(this.state.uiLanguage === "en" ? "Preparing response." : "응답을 준비하는 중입니다.")
		this.schedulePersistedStateSave()
		this.sendPartialMessage(userMessage)
		this.broadcastState().catch((error) => console.error(error))

		const sendParams: SendMessageCommand = {
			sessionId,
			prompt: getString(message, "text"),
			mode: this.state.mode === "plan" ? "plan" : "act",
			userImages: await normalizeSdkImageInputs(getStringArray(message, "images")),
			userFiles: getStringArray(message, "files"),
			delivery: normalizePromptDelivery(getString(message, "delivery")),
		}
		void this.runLifecycleHooks("UserPromptSubmit", {
			prompt: getString(message, "text"),
			sessionId,
			images: getStringArray(message, "images"),
			files: getStringArray(message, "files"),
		})

		const runGeneration = ++this.sdkRunGeneration
		this.sendOrResumeSdkSession(sessionId, sendParams, text.length).then((result) =>
			this.completeFromSdkResult(result, getString(asRecord(result), "sessionId") || sessionId, "send", runGeneration),
		).catch(async (error) => {
			if (runGeneration !== this.sdkRunGeneration) {
				this.logger.log("sidecar", "ignoredSupersededSdkError", {
					source: "send",
					sessionId,
					runGeneration,
					currentRunGeneration: this.sdkRunGeneration,
					error: error instanceof Error ? error.message : String(error),
				})
				return
			}
			await this.recoverFromSdkRunError(sessionId, "send", runGeneration, error)
		})
	}

	private async compactCurrentSession(requestId = createId()) {
		if (!this.clineSdk) {
			throw new Error("LIG VS SDK runtime is not attached.")
		}

		const activeSessionId = this.clineSdk.status.activeSessionId
		const selectedSessionId = String(this.state.currentTaskItem?.id || "")
		const sessionId = activeSessionId || selectedSessionId
		if (!sessionId) {
			this.addMessage({
				type: "say",
				say: "error",
				text: this.state.uiLanguage === "en" ? "No active session to compact." : "압축할 활성 세션이 없습니다.",
			})
			await this.broadcastState()
			return
		}

		const prompt =
			this.state.uiLanguage === "en"
				? "Internal maintenance request: compact the current conversation context for future turns. Preserve the user's goals, important decisions, file paths, errors, pending tasks, and current state. Do not treat this as a user feature request."
				: "내부 유지보수 요청: 이후 대화를 위해 현재 대화 컨텍스트를 압축해 주세요. 사용자의 목표, 중요한 결정, 파일 경로, 오류, 남은 작업, 현재 상태를 보존하세요. 이것을 사용자의 일반 기능 요청으로 처리하지 마세요."

		this.startSendLatencyTrace(requestId, "askResponse", sessionId, prompt.length)
		this.foldedProgressProjector.beginReasoning()
		this.upsertFoldedReasoningText(this.state.uiLanguage === "en" ? "Compacting context..." : "컨텍스트 압축 중입니다.")
		this.schedulePersistedStateSave()
		await this.broadcastState()

		const sendParams: SendMessageCommand = {
			sessionId,
			prompt,
			mode: this.state.mode === "plan" ? "plan" : "act",
			delivery: "steer" as const,
		}

		const runGeneration = ++this.sdkRunGeneration
		try {
			const result = await this.sendOrResumeSdkSession(sessionId, sendParams, prompt.length)
			await this.completeFromSdkResult(result, getString(asRecord(result), "sessionId") || sessionId, "compact", runGeneration)
		} catch (error) {
			if (runGeneration !== this.sdkRunGeneration) {
				this.logger.log("sidecar", "ignoredSupersededSdkError", {
					source: "compact",
					sessionId,
					runGeneration,
					currentRunGeneration: this.sdkRunGeneration,
					error: error instanceof Error ? error.message : String(error),
				})
				return
			}
			await this.recoverFromSdkRunError(sessionId, "compact", runGeneration, error)
		}
	}

	private async sendOrResumeSdkSession(
		sessionId: string,
		sendParams: SendMessageCommand,
		textLength: number,
	): Promise<unknown> {
		if (!this.clineSdk) {
			throw new Error("LIG VS SDK runtime is not attached.")
		}

		let activateMissing = false
		if (this.clineSdk.status.activeSessionId !== sessionId) {
			this.logger.log("sidecar", "sendAskResponse.activateSession", {
				from: this.clineSdk.status.activeSessionId,
				to: sessionId,
			})
			await this.clineSdk.activateSession(sessionId).catch((error) => {
				if (!isSessionNotFoundError(error)) {
					throw error
				}
				activateMissing = true
				this.logger.log("sidecar", "sendAskResponse.activateSessionMissing", {
					sessionId,
					error: error instanceof Error ? error.message : String(error),
				})
			})
		}

		try {
			if (activateMissing) {
				return await this.resumeSdkSessionForSend(sessionId, sendParams, textLength)
			}
			if (this.activeSessionRuntimeSettingsRevision !== this.runtimeSettingsRevision) {
				this.logger.log("sidecar", "sendAskResponse.restartForSettingsChange", {
					sessionId,
					activeSessionRuntimeSettingsRevision: this.activeSessionRuntimeSettingsRevision,
					runtimeSettingsRevision: this.runtimeSettingsRevision,
				})
				this.closingSessionIds.add(sessionId)
				await this.clineSdk.stop({ sessionId }).catch((error) => {
					this.logger.log("sidecar", "sendAskResponse.stopForSettingsChangeFailed", {
						sessionId,
						error: error instanceof Error ? error.message : String(error),
					})
				})
				this.closingSessionIds.delete(sessionId)
				return await this.resumeSdkSessionForSend(sessionId, sendParams, textLength)
			}
			this.markSendLatencySdkSend(sessionId)
			this.logger.log("sidecar", "sendAskResponse.sdkSend", { sessionId, textLength })
			if (!this.sendMessage) {
				throw new Error("SendMessageHandler is not attached.")
			}
			return await this.sendMessage.execute(sendParams)
		} catch (error) {
			this.markSendLatencyError(sessionId, error)
			if (!isSessionNotFoundError(error)) {
				throw error
			}
			this.logger.log("sidecar", "sendAskResponse.sdkSendMissingSession", {
				sessionId,
				error: error instanceof Error ? error.message : String(error),
			})
			return await this.resumeSdkSessionForSend(sessionId, sendParams, textLength)
		}
	}

	private async resumeSdkSessionForSend(
		sessionId: string,
		sendParams: SendMessageCommand,
		textLength: number,
	): Promise<unknown> {
		if (!this.clineSdk) {
			throw new Error("LIG VS SDK runtime is not attached.")
		}

		const workspaceRoots = await this.host.workspaceClient.getWorkspacePaths({})
		const cwd = String(this.state.currentTaskItem?.cwdOnTaskInitialization || "") || workspaceRoots[0] || process.cwd()
		const prompt = getString(sendParams, "prompt")
		const userImages = getStringArray(sendParams, "userImages")
		const userFiles = getStringArray(sendParams, "userFiles")
		const taskItem = this.state.currentTaskItem || createHistoryItem(sessionId, prompt, cwd, this.getModelId())

		this.state.currentTaskItem = {
			...taskItem,
			id: sessionId,
			cwdOnTaskInitialization: cwd,
			modelId: String(taskItem.modelId || "") || this.getModelId(),
		}
		this.state.taskHistory = upsertTaskHistoryItem(this.state.taskHistory, this.state.currentTaskItem)
		this.noteTaskActivity("resume-session")
		this.updateCurrentTaskItem()
		await this.broadcastState()

		this.logger.log("sidecar", "sendAskResponse.resumeStartSession", {
			sessionId,
			textLength,
			cwd,
		})
		void this.runLifecycleHooks("TaskResume", { prompt, cwd, userImages, userFiles, sessionId })
		const initialMessages = buildResumedConversationMessages(
			this.state.clineMessages,
			prompt,
			this.getResumedConversationCharBudget(),
		)
		const taskTitle = String(taskItem.task || "").trim()
		if (!this.startTaskHandler) throw new Error("StartTaskHandler is not attached.")
		return this.startTaskHandler.execute({
			prompt,
			cwd,
			userImages: await normalizeSdkImageInputs(userImages),
			userFiles,
			interactive: true,
			initialMessages,
			sessionMetadata: taskTitle ? { title: taskTitle, ligVsResumed: true } : { ligVsResumed: true },
			config: await this.buildSdkConfig(cwd, sessionId),
			toolPolicies: this.createCurrentToolPolicies(),
		}).then((result) => {
			this.activeSessionRuntimeSettingsRevision = this.runtimeSettingsRevision
			return result
		})
	}

	private async completeFromSdkResult(result: unknown, fallbackSessionId: string, source: string, runGeneration: number) {
		const resultRecord = asRecord(result)
		const sessionId = getString(resultRecord, "sessionId") || fallbackSessionId || String(this.state.currentTaskItem?.id || "")
		if (runGeneration !== this.sdkRunGeneration) {
			this.logger.log("sidecar", "ignoredSupersededSdkResult", {
				source,
				sessionId,
				runGeneration,
				currentRunGeneration: this.sdkRunGeneration,
			})
			return
		}

		if (sessionId && fallbackSessionId && sessionId !== fallbackSessionId && String(this.state.currentTaskItem?.id || "") === fallbackSessionId) {
			this.bindCurrentTaskToSession(sessionId)
		}

		if (!this.isCurrentSdkResultSession(sessionId)) {
			this.logger.log("sidecar", "ignoredStaleSdkResult", {
				source,
				sessionId,
				currentTaskId: this.state.currentTaskItem?.id,
				activeSessionId: this.clineSdk?.status.activeSessionId,
			})
			return
		}

		if (await this.hydrateCurrentTaskFromSdk(sessionId, `complete:${source}`, true)) {
			await this.broadcastState()
			return
		}

		const agentResult = asRecord(resultRecord.result ?? result)
		if (Object.keys(agentResult).length === 0) {
			this.logger.log("sidecar", "emptySdkResult", {
				source,
				sessionId,
				lastTaskActivityReason: (this.taskActivity?.reason || ""),
				activePartialTextLength: this.getActivePartialText().length,
				hasAssistantTextAfterLastUserMessage: this.hasAssistantTextAfterLastUserMessage(),
			})
			const activeText = this.getActivePartialText()
			if (activeText || this.hasAssistantTextAfterLastUserMessage()) {
				this.finishSdkTask(sessionId, "completed", activeText)
				this.updateCurrentTaskItem()
				await this.broadcastState()
			} else if (await this.hydrateCurrentTaskFromSdk(sessionId, `empty:${source}`, true)) {
				await this.broadcastState()
			} else {
				this.failSdkTaskWithMessage(sessionId, formatEmptyModelResponseForUi(this.getUiLanguage()))
				this.updateCurrentTaskItem()
				await this.broadcastState()
			}
			return
		}

		const resultText = extractCompletionTextFromResult(agentResult, resultRecord)
		const finishReason = getString(agentResult, "finishReason") || getString(agentResult, "status") || "completed"
		if (resultText) {
			this.finishSdkTask(sessionId, finishReason, resultText)
		} else if (!this.hasAssistantTextAfterLastUserMessage()) {
			this.logger.log("sidecar", "emptySdkResultNoAssistantText", {
				source,
				sessionId,
				finishReason,
				lastTaskActivityReason: (this.taskActivity?.reason || ""),
			})
			this.failSdkTaskWithMessage(sessionId, formatEmptyModelResponseForUi(this.getUiLanguage()))
		} else {
			this.finalizeOpenPartialMessages()
			this.addCompletionResultMarker(finishReason)
		}

		this.updateCurrentTaskItem()
		await this.broadcastState()
	}

	private async recoverFromSdkRunError(sessionId: string, source: string, runGeneration: number, error: unknown) {
		this.logger.log("sidecar", "sdkRunErrorRecoveryStarted", {
			source,
			sessionId,
			runGeneration,
			error: stringify(error),
			activePartialTextLength: this.getActivePartialText().length,
			hasAssistantTextAfterLastUserMessage: this.hasAssistantTextAfterLastUserMessage(),
		})

		const recoveryDelays = [0, 500, 1500, 3000]
		for (const delayMs of recoveryDelays) {
			if (runGeneration && runGeneration !== this.sdkRunGeneration) {
				this.logger.log("sidecar", "sdkRunErrorRecoveryCancelled", {
					source,
					sessionId,
					runGeneration,
					currentRunGeneration: this.sdkRunGeneration,
				})
				return
			}

			if (delayMs > 0) {
				await delay(delayMs)
			}

			if (await this.hydrateCurrentTaskFromSdk(sessionId, `error:${source}:${delayMs}`, true)) {
				this.updateCurrentTaskItem()
				await this.broadcastState()
				this.logger.log("sidecar", "sdkRunErrorRecoveredByHydration", { source, sessionId, delayMs })
				return
			}
		}

		const activeText = this.getActivePartialText()
		if (activeText || this.hasAssistantTextAfterLastUserMessage()) {
			this.finishSdkTask(sessionId, "completed", activeText)
			this.updateCurrentTaskItem()
			await this.broadcastState()
			this.logger.log("sidecar", "sdkRunErrorRecoveredByPartialText", {
				source,
				sessionId,
				activeTextLength: activeText.length,
			})
			return
		}

		this.clearTaskIdleWatchdog()
		this.transitionTask("failed", `sdk-error:${source}`)
		this.clearPartialIdleWatchdog()
		this.clearReasoningStatus()
		this.addMessage({ type: "say", say: "error", text: formatSdkErrorForUi(error, this.getUiLanguage()) })
		this.updateCurrentTaskItem()
		await this.broadcastState()
	}

	private async cancelTask() {
		if (!this.transitionTask("cancelling", "cancel-request")) {
			this.logger.log("sidecar", "duplicateCancelIgnored", { status: this.taskLifecycle.status })
			return
		}
		this.sdkRunGeneration++
		const sessionIdForHook = this.clineSdk?.status.activeSessionId || String(this.state.currentTaskItem?.id || "")
		let cancelledSessionId = ""
		if (this.clineSdk && this.cancelTaskHandler) {
			const sessionId = this.clineSdk.status.activeSessionId
			if (sessionId) {
				cancelledSessionId = sessionId
				await this.cancelTaskHandler.execute({ sessionId }).catch((error) => {
					this.logger.log("sidecar", "cancelAbortFailed", {
						sessionId,
						error: error instanceof Error ? error.message : String(error),
					})
				})
			}
		}
		this.clearTaskIdleWatchdog()
		this.clearPartialIdleWatchdog()
		this.clearPartialStateBroadcastTimer()
		this.finalizeActivePartialText()
		this.finishActiveToolActivity()
		this.finishFoldedReasoningText()
		this.finalizeOpenPartialMessages()
		this.removeTerminalAskMessages()
		this.addMessage({ type: "say", say: "info", text: "현재 진행 중인 요청을 취소했습니다. 이전 대화와 세션은 유지됩니다." })
		this.updateCurrentTaskItem()
		await this.runLifecycleHooks("TaskCancel", { sessionId: sessionIdForHook })
		this.transitionTask("idle", "cancel-complete")
		await this.broadcastState()
	}

	private async clearTask() {
		this.transitionTask("cancelling", "clear-task")
		this.sdkRunGeneration++
		const sessionId = this.clineSdk?.status.activeSessionId || String(this.state.currentTaskItem?.id || "")
		if (this.clineSdk && sessionId) {
			this.closingSessionIds.add(sessionId)
			await this.clineSdk.abort({ sessionId }).catch((error) => {
				this.logger.log("sidecar", "clearTaskAbortFailed", {
					sessionId,
					error: error instanceof Error ? error.message : String(error),
				})
			})
			await this.clineSdk.stop({ sessionId }).catch((error) => {
				this.logger.log("sidecar", "clearTaskStopFailed", {
					sessionId,
					error: error instanceof Error ? error.message : String(error),
				})
			})
		}

		if (this.state.currentTaskItem && this.state.clineMessages.length > 0) {
			const taskId = String(this.state.currentTaskItem.id || sessionId)
			if (taskId) {
				this.rememberTaskSnapshot(taskId, this.state.currentTaskItem, this.state.clineMessages)
			}
		}

		this.clearTaskIdleWatchdog()
		this.clearPartialIdleWatchdog()
		this.clearPartialStateBroadcastTimer()
		this.finalizeActivePartialText()
		this.finishActiveToolActivity()
		this.finishFoldedReasoningText()
		this.approvals.clear({ approved: false, reason: "Task was closed." })
		this.pendingQuestion?.resolve("")
		this.pendingQuestion = null
		this.state.currentTaskItem = null
		this.state.clineMessages = []
		const transition = this.taskLifecycle.reset("clear-task-complete")
		this.state.taskLifecycleStatus = transition.current
		this.stateStore.save(createPersistedStateSnapshot(this.state))
		await this.broadcastState()

		this.clineSdk?.markSessionInactive(sessionId)
	}

	private async showTaskWithId(taskId: string) {
		await this.taskTranscriptHydrator.show(taskId)
	}

	private async refreshSelectedTaskFromSdk() {
		await this.taskTranscriptHydrator.refreshSelected()
	}

	private async hydrateCurrentTaskFromSdk(sessionId: string, source: string, force = false) {
		return this.taskTranscriptHydrator.hydrateCurrent(sessionId, source, force)
	}

	private async restoreCheckpoint(message: unknown) {
		if (!this.clineSdk || !this.state.currentTaskItem) {
			throw new Error("No SDK-backed task is selected for checkpoint restore.")
		}
		const workspaceRoots = await this.host.workspaceClient.getWorkspacePaths({})
		const cwd = workspaceRoots[0] || String(this.state.currentTaskItem.cwdOnTaskInitialization || process.cwd())
		const result = await this.requireCheckpoints().restore(message, {
			taskItem: this.state.currentTaskItem,
			messages: this.state.clineMessages,
			cwd,
			config: await this.buildSdkConfig(cwd, String(this.state.currentTaskItem.id || "")),
			toolPolicies: this.createCurrentToolPolicies(),
		})
		if (result.restoredSessionId) {
			await this.showTaskWithId(result.restoredSessionId)
		} else {
			this.addMessage({ type: "say", say: "info", text: "Checkpoint workspace restore completed." })
			await this.broadcastState()
		}
	}

	private async describeCheckpointDiff(message: unknown) {
		const trackedChanges = this.requireChangeTracking().pendingChanges()
		const description = this.requireCheckpoints().describe(message, { taskItem: this.state.currentTaskItem, messages: this.state.clineMessages, trackedChanges })

		if (description.success) this.addMessage({
			type: "say",
			say: "info",
			text: description.text,
			checkpointRunCount: description.checkpointRunCount,
		})
		if (description.success) this.updateCurrentTaskItem()
		return description
	}

	private async refreshSdkInstructionSettings() {
		const result = await this.requireSdkSettings().instructions(await this.getPrimaryWorkspaceRoot())
		const { globalClineRulesToggles, localClineRulesToggles, globalWorkflowToggles, localWorkflowToggles } = result

		this.state.globalClineRulesToggles = globalClineRulesToggles
		this.state.localClineRulesToggles = localClineRulesToggles
		this.state.globalWorkflowToggles = globalWorkflowToggles
		this.state.localWorkflowToggles = localWorkflowToggles

		return {
			globalClineRulesToggles: { toggles: globalClineRulesToggles },
			localClineRulesToggles: { toggles: localClineRulesToggles },
			localCursorRulesToggles: { toggles: this.state.localCursorRulesToggles },
			localWindsurfRulesToggles: { toggles: this.state.localWindsurfRulesToggles },
			localAgentsRulesToggles: { toggles: this.state.localAgentsRulesToggles },
			globalWorkflowToggles: { toggles: globalWorkflowToggles },
			localWorkflowToggles: { toggles: localWorkflowToggles },
		}
	}

	private async refreshHookSettings() {
		const workspaceRoot = await this.getPrimaryWorkspaceRoot()
		this.state.hooksEnabled = true
		return this.requireHookSettings().settings(workspaceRoot)
	}

	private async createHook(message: unknown) {
		const workspaceRoot = await this.getPrimaryWorkspaceRoot()
		return this.requireHookSettings().create(message, workspaceRoot)
	}

	private async deleteHook(message: unknown) {
		const workspaceRoot = await this.getPrimaryWorkspaceRoot()
		return this.requireHookSettings().delete(message, workspaceRoot)
	}

	private async toggleHook(message: unknown) {
		const workspaceRoot = await this.getPrimaryWorkspaceRoot()
		return this.requireHookSettings().toggle(message, workspaceRoot)
	}

	private async listScheduledAgentSpecs() {
		return this.requireScheduledAgents().list(await this.getPrimaryWorkspaceRoot())
	}

	private async saveScheduledAgentSpec(message: unknown) {
		const workspaceRoot = await this.getPrimaryWorkspaceRoot()
		return this.requireScheduledAgents().save(message, workspaceRoot)
	}

	private async deleteScheduledAgentSpec(message: unknown) {
		const workspaceRoot = await this.getPrimaryWorkspaceRoot()
		return this.requireScheduledAgents().delete(message, workspaceRoot)
	}

	private async runScheduledAgentSpec(message: unknown) {
		const workspaceRoot = await this.getPrimaryWorkspaceRoot()
		return this.requireScheduledAgents().run(message, workspaceRoot, async (request) => { await this.startNewTask(request, { broadcast: false }) })
	}

	private async getLocalPluginConfigStatus() {
		const workspaceRoot = await this.getPrimaryWorkspaceRoot().catch(() => "")
		const plugins = discoverLocalPlugins(workspaceRoot)
		return {
			success: true,
			supported: true,
			plugins,
			items: plugins,
			count: plugins.length,
			workspaceRoot,
			marketplaceEnabled: false,
			marketplaceInstallSupported: false,
			marketplaceDisabledReason: "Air-gap Visual Studio mode only discovers local plugin configuration; online marketplace install is intentionally disabled.",
		}
	}

	private async refreshSdkSkills() {
		const { globalSkills, localSkills, globalSkillsToggles, localSkillsToggles } = await this.requireSdkSettings().skills(await this.getPrimaryWorkspaceRoot())

		this.state.globalSkillsToggles = globalSkillsToggles
		this.state.localSkillsToggles = localSkillsToggles
		return { globalSkills, localSkills, globalSkillsToggles, localSkillsToggles }
	}

	private async toggleSdkSetting(type: "rules" | "workflows" | "skills", message: unknown) {
		const result = await this.requireSdkSettings().toggle(type, message, await this.getPrimaryWorkspaceRoot())
		if (!result.success) this.addMessage({ type: "say", say: "error", text: result.error })
	}

	private toggleFavoriteModel(modelId: string) {
		if (!modelId) {
			return
		}

		const current = new Set<string>(this.state.favoritedModelIds)
		if (current.has(modelId)) {
			current.delete(modelId)
		} else {
			current.add(modelId)
		}
		this.state.favoritedModelIds = [...current]
	}

	private applyBannerDismissal(message: unknown) {
		const banner = getString(message, "value") || getString(message, "banner") || getString(message, "id")
		const version = getNumber(message, "version") || Date.now()
		if (banner.includes("model")) {
			this.state.lastDismissedModelBannerVersion = version
		} else if (banner.includes("cli")) {
			this.state.lastDismissedCliBannerVersion = version
		} else {
			this.state.lastDismissedInfoBannerVersion = version
		}
	}

	private handleSessionChunk(payload: Record<string, unknown>) {
		const stream = getString(payload, "stream")
		const chunk = getString(payload, "chunk")
		const chunkRecord = asRecord(payload.chunk)
		if (!chunk && Object.keys(chunkRecord).length === 0) {
			return
		}

		if (stream === "agent") {
			this.noteQuietTaskActivity("chunk:agent")
			this.addAgentTranscriptChunk(payload.chunk)
			return
		}

		this.noteTaskActivity(`chunk:${stream || "unknown"}`)
		const text = truncateText(chunk, readPositiveIntEnv("VSCLINE_COMMAND_OUTPUT_CHARS", 12000))
		this.addMessage({
			type: "say",
			say: stream === "stderr" ? "command_output" : "tool",
			text,
			isCollapsed: true,
			isExpanded: false,
		})
		this.updateCurrentTaskItem()
		this.broadcastState().catch((error) => console.error(error))
	}

	private addAgentTranscriptChunk(chunk: unknown) {
		const terminal = agentChunkToTerminalResult(chunk)
		if (terminal) {
			this.noteTaskActivity(terminal.reason)
			this.finishSdkTask(this.clineSdk?.status.activeSessionId || String(this.state.currentTaskItem?.id || ""), terminal.status, terminal.text)
			this.updateCurrentTaskItem()
			this.broadcastState().catch((error) => console.error(error))
			return
		}

		const text = agentChunkToTranscriptText(chunk)
		if (!text.trim()) {
			const reasoning = agentChunkToFoldedReasoningText(chunk)
			if (reasoning.trim()) {
				this.upsertFoldedReasoningText(reasoning)
				this.updateCurrentTaskItem()
				this.schedulePartialStateBroadcast()
				return
			}
			this.logger.log("sidecar", "sdkAgentChunkSkippedForUi", summarizeAgentChunkForLog(chunk))
			return
		}

		const capped = truncateText(text, readPositiveIntEnv("VSCLINE_AGENT_TRANSCRIPT_CHARS", 12000))
		if (this.isDuplicateRecentTranscript(capped)) {
			return
		}

		if (isToolTranscript(capped)) {
			this.recordToolActivity("tool", capped)
		} else {
			this.addMessage({
				type: "say",
				say: "text",
				text: capped,
			})
		}
		this.updateCurrentTaskItem()
		this.broadcastState().catch((error) => console.error(error))
	}

	private isDuplicateRecentTranscript(text: string) {
		const normalized = normalizeTranscriptText(text)
		if (!normalized) {
			return true
		}

		return this.state.clineMessages.slice(-3).some((message) => normalizeTranscriptText(getString(message, "text")) === normalized)
	}

	private handleSessionSnapshot(payload: Record<string, unknown>) {
		const sessionId = getString(payload, "sessionId")
		if (sessionId) {
			this.bindCurrentTaskToSession(sessionId)
		}

		const snapshot = asRecord(payload.snapshot)
		const status = getString(snapshot, "status")
		const model = asRecord(snapshot.model)
		const aggregateUsage = asRecord(snapshot.aggregateUsage)
		const usage = normalizeUsageSnapshot(Object.keys(aggregateUsage).length > 0 ? aggregateUsage : asRecord(snapshot.usage))
		if (status === "idle") {
			this.finishSdkTask(sessionId, "completed", this.getActivePartialText())
		} else {
			this.noteTaskActivity(`session_snapshot:${status || "unknown"}`)
		}
		this.updateCurrentTaskItem({
			modelId: getString(model, "modelId") || undefined,
			tokensIn: usage.reliable ? usage.inputTokens : undefined,
			tokensOut: usage.reliable ? usage.outputTokens : undefined,
			cacheReads: usage.reliable ? usage.cacheReadTokens : undefined,
			cacheWrites: usage.reliable ? usage.cacheWriteTokens : undefined,
			totalCost: usage.reliable ? usage.totalCost : undefined,
		})
		if (status && status !== "running" && status !== "pending" && status !== "starting" && status !== "idle") {
			const activeText = this.getActivePartialText()
			this.finishSdkTask(sessionId, status, activeText)
		}
		this.broadcastState().catch((error) => console.error(error))
	}

	private handleTeamProgress(payload: Record<string, unknown>) {
		const summary = asRecord(payload.summary)
		const lifecycle = asRecord(payload.lifecycle)
		const agents = arrayOfRecords(payload.agents || payload.subagents || payload.members)
		const results = arrayOfRecords(payload.results || payload.outputs)
		const message =
			getString(summary, "message") ||
			getString(summary, "status") ||
			getString(lifecycle, "phase") ||
			getString(payload, "teamName") ||
			"Team progress updated."
		this.noteTaskActivity("team_progress")
		this.addMessage({
			type: "say",
			say: "use_subagents",
			text: JSON.stringify({
				message,
				teamId: getString(payload, "teamId") || getString(payload, "id") || undefined,
				teamName: getString(payload, "teamName") || undefined,
				phase: getString(lifecycle, "phase") || getString(payload, "phase") || undefined,
				status: getString(summary, "status") || getString(payload, "status") || undefined,
				agents: agents.map((agent) => ({
					id: getString(agent, "id") || getString(agent, "agentId"),
					name: getString(agent, "name") || getString(agent, "role"),
					status: getString(agent, "status") || getString(agent, "phase"),
					progress: getNumber(agent, "progress"),
				})),
				results: results.map((result) => ({
					id: getString(result, "id") || getString(result, "agentId"),
					status: getString(result, "status"),
					summary: truncateText(getString(result, "summary") || getString(result, "text"), 500),
				})),
			}),
			isCollapsed: true,
			isExpanded: false,
		})
		this.logger.log("sidecar", "teamProgress", { message: truncateText(message, 500), agents: agents.length, results: results.length })
		this.updateCurrentTaskItem()
		this.broadcastState().catch((error) => console.error(error))
	}

	private handleHookEvent(payload: Record<string, unknown>) {
		const hookEventName = getString(payload, "hookEventName")
		const toolName = getString(payload, "toolName")
		const text = JSON.stringify({
			hookEventName,
			toolName,
			agentId: getString(payload, "agentId") || undefined,
			conversationId: getString(payload, "conversationId") || undefined,
			iteration: getNumber(payload, "iteration"),
		})
		this.noteTaskActivity(`hook:${hookEventName || "unknown"}`)
		this.addMessage({ type: "say", say: "hook_status", text })
		this.updateCurrentTaskItem()
		this.broadcastState().catch((error) => console.error(error))
	}

	private async runLifecycleHooks(hookName: HookLifecycleName, context: Record<string, unknown> = {}) {
		const workspaceRoot = await this.getPrimaryWorkspaceRoot().catch(() => "")
		return this.requireHookExecution().run(hookName, context, workspaceRoot, this.state.hooksEnabled !== false, this.createHookExecutionObserver())
	}

	private async runPreToolUseHooks(context: Record<string, unknown>): Promise<PreToolUseDecision> {
		const workspaceRoot = await this.getPrimaryWorkspaceRoot().catch(() => "")
		return this.requireHookExecution().preToolUse(context, workspaceRoot, this.state.hooksEnabled !== false, this.createHookExecutionObserver())
	}

	private createHookExecutionObserver(): HookExecutionObserver {
		const messageIds = new Map<string, number>()
		return {
			started: async (hook, context) => {
				const ts = Date.now() + this.messageSequence++
				messageIds.set(`${hook.source}:${hook.name}:${hook.path}`, ts)
				this.state.clineMessages.push({ ts, type: "say", say: "hook_status", text: JSON.stringify(createHookMetadata(hook, "running", context)) })
				this.updateCurrentTaskItem()
				await this.broadcastState().catch((error) => console.error(error))
			},
			completed: async (result, context) => {
				const ts = messageIds.get(`${result.hook.source}:${result.hook.name}:${result.hook.path}`) || Date.now() + this.messageSequence++
				const metadata = createHookMetadata(result.hook, result.exitCode === 0 ? "completed" : "failed", context, result, result.jsonResponse)
				const output = [result.stdout, result.stderr ? `stderr:\n${result.stderr}` : ""].filter(Boolean).join("\n\n")
				this.upsertMessage(ts, { type: "say", say: "hook_status", text: output ? `${JSON.stringify(metadata)}\n__HOOK_OUTPUT__\n${output}` : JSON.stringify(metadata) })
				this.updateCurrentTaskItem()
				await this.broadcastState().catch((error) => console.error(error))
			},
		}
	}

	private handlePendingPrompts(payload: Record<string, unknown>) {
		const prompts = Array.isArray(payload.prompts) ? payload.prompts : []
		this.noteTaskActivity("pending_prompts")
		if (prompts.length > 0) {
			this.logger.log("sidecar", "pendingPrompts", { count: prompts.length })
		}
		this.updateCurrentTaskItem()
		this.broadcastState().catch((error) => console.error(error))
	}

	private handlePendingPromptSubmitted(payload: Record<string, unknown>) {
		const prompt = getString(payload, "prompt")
		this.noteTaskActivity("pending_prompt_submitted")
		if (prompt) {
			this.logger.log("sidecar", "pendingPromptSubmitted", { prompt: truncateText(prompt, 160) })
		}
		this.updateCurrentTaskItem()
		this.broadcastState().catch((error) => console.error(error))
	}

	private getBrowserSettings(): BrowserSettings {
		const settings = asRecord(this.state.browserSettings)
		return {
			remoteBrowserEnabled: settings.remoteBrowserEnabled === true,
			remoteBrowserHost: getString(settings, "remoteBrowserHost"),
			chromeExecutablePath: getString(settings, "chromeExecutablePath"),
			disableToolUse: settings.disableToolUse === true,
			viewport: settings.viewport,
			webFetchEnabled: isWebFetchEnabled(settings),
			webFetchDisabledReason: webFetchDisabledReason(settings),
		}
	}

	private requireBrowserHandler() {
		if (!this.browserHandler) throw new Error("Browser feature handler is not attached.")
		return this.browserHandler
	}

	private requireWorktreeQueries() {
		if (!this.worktreeQueries) throw new Error("Worktree query handler is not attached.")
		return this.worktreeQueries
	}

	private requireWorktreeMutations() {
		if (!this.worktreeMutations) throw new Error("Worktree mutation handler is not attached.")
		return this.worktreeMutations
	}

	private requireOAuthAuthorization() {
		if (!this.oauthAuthorization) throw new Error("OAuth authorization handler is not attached.")
		return this.oauthAuthorization
	}

	private requireOAuthCallbackHandler() {
		if (!this.oauthCallbackHandler) throw new Error("OAuth callback handler is not attached.")
		return this.oauthCallbackHandler
	}

	private requireProviderCredentials() {
		if (!this.providerCredentials) throw new Error("Provider credential handler is not attached.")
		return this.providerCredentials
	}

	private requireProviderAuthActions() {
		if (!this.providerAuthActions) throw new Error("Provider auth action handler is not attached.")
		return this.providerAuthActions
	}

	private requireScheduledAgents() {
		if (!this.scheduledAgents) throw new Error("Scheduled agent handler is not attached.")
		return this.scheduledAgents
	}

	private requireHookSettings() {
		if (!this.hookSettings) throw new Error("Hook settings handler is not attached.")
		return this.hookSettings
	}

	private requireHookExecution() {
		if (!this.hookExecution) throw new Error("Hook execution handler is not attached.")
		return this.hookExecution
	}

	private requireCheckpoints() {
		if (!this.checkpoints) throw new Error("Checkpoint handler is not attached.")
		return this.checkpoints
	}

	private requireTerminalActivity() {
		if (!this.terminalActivity) throw new Error("Terminal activity monitor is not attached.")
		return this.terminalActivity
	}

	private requireTaskActivity() {
		if (!this.taskActivity) throw new Error("Task activity monitor is not attached.")
		return this.taskActivity
	}

	private requirePartialStateScheduler() {
		if (!this.partialStateScheduler) throw new Error("Partial state scheduler is not attached.")
		return this.partialStateScheduler
	}

	private requireSendLatency() {
		if (!this.sendLatency) throw new Error("Send latency monitor is not attached.")
		return this.sendLatency
	}

	private requireChangeTracking() {
		if (!this.changeTracking) throw new Error("Change tracking handler is not attached.")
		return this.changeTracking
	}

	private requireProviderModelCatalogs() {
		if (!this.providerModelCatalogs) throw new Error("Provider model catalog handler is not attached.")
		return this.providerModelCatalogs
	}

	private requireStreamPublisher() {
		if (!this.streamPublisher) throw new Error("Webview stream publisher is not attached.")
		return this.streamPublisher
	}

	private requireSdkSettings() {
		if (!this.sdkSettings) throw new Error("SDK settings handler is not attached.")
		return this.sdkSettings
	}

	private async handleBrowserToolEvent(toolName: string, input: Record<string, unknown>, error: string) {
		const action = normalizeBrowserActionName(getString(input, "action") || getString(input, "name") || toolName)
		const url = getString(input, "url") || getString(input, "value")
		if (action === "launch" || action === "navigate") {
			this.addMessage({ type: "say", say: "browser_action_launch", text: url || "" })
		} else {
			this.addMessage({
				type: "say",
				say: "browser_action",
				text: JSON.stringify({
					action,
					coordinate: getString(input, "coordinate"),
					text: getString(input, "text"),
				}),
			})
		}

		let result: Record<string, unknown>
		if (error) {
			result = { success: false, status: "error", error }
		} else {
			result = asRecord(await this.requireBrowserHandler().performAction({ ...input, action }, this.getBrowserSettings()))
		}

		for (const phase of arrayOfRecords(result.phases)) {
			this.addMessage({
				type: "say",
				say: "browser_action",
				text: JSON.stringify({
					action,
					phase: getString(phase, "phase"),
					tabId: getString(phase, "tabId"),
					browserSessionId: getString(phase, "browserSessionId"),
					browserActionId: getString(phase, "browserActionId"),
					reconnectReason: getString(phase, "reconnectReason"),
				}),
			})
		}

		this.addMessage({
			type: "say",
			say: "browser_action_result",
			text: JSON.stringify(browserActionResultForTranscript(result)),
		})
		this.updateCurrentTaskItem()
		await this.broadcastState()
	}

	private isCurrentSdkResultSession(sessionId: string) {
		if (!sessionId || this.closingSessionIds.has(sessionId) || this.taskHistorySync.isDeleted(sessionId)) {
			return false
		}

		const currentTaskId = String(this.state.currentTaskItem?.id || "")
		return !!currentTaskId && currentTaskId === sessionId
	}

	private handleAgentEvent(semanticEvent: AgentEvent, sessionId = semanticEvent.sessionId) {
		if (sessionId) {
			this.bindCurrentTaskToSession(sessionId)
		}

		const textProjection = this.agentTextEvents.handle(semanticEvent)
		if (textProjection.handled) {
			this.updateCurrentTaskItem()
			if (textProjection.broadcast) this.broadcastState().catch((error) => console.error(error))
			return
		}

		const toolProjection = this.agentToolEvents.handle(semanticEvent)
		if (toolProjection.handled) {
			this.updateCurrentTaskItem()
			if (toolProjection.broadcast) this.broadcastState().catch((error) => console.error(error))
			return
		}

		const lifecycleProjection = this.agentLifecycleEvents.handle(semanticEvent)
		if (lifecycleProjection.handled) {
			this.updateCurrentTaskItem()
			if (lifecycleProjection.broadcast) this.broadcastState().catch((error) => console.error(error))
			return
		}

		this.updateCurrentTaskItem()
		this.broadcastState().catch((error) => console.error(error))
	}

	private handleReasoningDelta(text: string) {
		if (!this.state.currentTaskItem) {
			return
		}

		const now = Date.now()
		const intervalMs = readPositiveIntEnv("VSCLINE_REASONING_STATUS_INTERVAL_MS", 2000)
		const status = this.conversationProjection.recordReasoning(now, intervalMs)
		if (status.started) this.logger.log("sidecar", "reasoningStarted", { textLength: text.length })
		if (!status.progress) return
		this.logger.log("sidecar", "reasoningProgress", {
			...status.progress,
			textLength: text.length,
		})
	}

	private clearReasoningStatus() {
		this.conversationProjection.clearReasoningStatus()
	}

	private async handleFileChangedEvent(payload: Record<string, unknown>) { this.requireChangeTracking().track(payload) }





	private async revertVsClineChanges(message: unknown) { return this.requireChangeTracking().revert(message) }

	private wasRecentlyTracked(filePath: string) { return this.requireChangeTracking().wasRecentlyTracked(filePath) }

	private hasRecentlyTrackedChange() { return this.requireChangeTracking().hasRecentlyTrackedChange() }



	private async buildSdkConfig(cwd: string, sessionId?: string) {
		const apiConfig = asRecord(this.state.apiConfiguration)
		const { modePrefix, providerId } = selectProvider(apiConfig, this.state.mode, process.env.CLINE_PROVIDER_ID || "anthropic")
		const sdkProviderId = normalizeSdkProviderId(providerId)
		const configuredBaseUrl = resolveBaseUrl(apiConfig, providerId)
		const modelLookupBaseUrl = providerId === "ollama" ? normalizeOllamaRootBaseUrl(configuredBaseUrl) : configuredBaseUrl
		const sdkBaseUrl = providerId === "ollama" ? normalizeOllamaOpenAiBaseUrl(configuredBaseUrl) : configuredBaseUrl
		const modelId = await this.resolveEffectiveModelId(apiConfig, providerId, modePrefix, modelLookupBaseUrl)
		const oauthCredentials = resolveOAuthCredentials(apiConfig, providerId)
		const oauthAccessToken = getString(oauthCredentials, "accessToken") || getString(oauthCredentials, "access_token")
		const apiKey = resolveApiKey(apiConfig, providerId) || oauthAccessToken || process.env.CLINE_API_KEY || process.env.ANTHROPIC_API_KEY || ""
		const maxTokensPerTurn = readOptionalPositiveIntEnv("VSCLINE_MAX_TOKENS_PER_TURN")
		const apiTimeoutMs = resolveRequestTimeoutMs(apiConfig)
		const reasoningEffort = resolveReasoningEffort(apiConfig, modePrefix)
		const thinking = resolveThinkingEnabled(apiConfig, modePrefix, providerId, reasoningEffort)
		const contextWindowTokens = resolveConfiguredContextWindow(apiConfig, providerId, modePrefix, modelId)
		const maxIterations = readOptionalPositiveIntEnv("VSCLINE_MAX_ITERATIONS")
		const maxParallelToolCalls = readOptionalPositiveIntEnv("VSCLINE_MAX_PARALLEL_TOOL_CALLS")
		const execution = buildOptionalExecutionConfig()
		const subagentsEnabled = this.state.subagentsEnabled === true || process.env.VSCLINE_ENABLE_SUBAGENTS === "1"
		const scheduledAgentsEnabled = this.isScheduledAgentsEnabled()
		const preferredLanguage = normalizePreferredLanguage(getString(this.state, "preferredLanguage"))
		const languageInstruction =
			preferredLanguage === "Korean - 한국어"
				? "Reply to the user in Korean unless the user explicitly asks for another language."
				: "Reply to the user in English unless the user explicitly asks for another language."
		const modeInstruction =
			this.state.mode === "plan"
				? "You are in PLAN mode. Do not modify files, run terminal commands, launch browsers, or perform destructive/external actions. Use read-only inspection only when necessary, ask clarifying questions when the requested change is ambiguous, and return a concrete plan for the user to approve before implementation."
				: "You are in ACT mode. You may implement approved changes using the available Visual Studio tools while keeping actions scoped to the user's request."
		const customPrompt = getString(this.state, "customPrompt").trim()
		const systemPrompt = [
			`You are LIG VS running inside Visual Studio 2022 through the VsClineAgent SDK wrapper. ${languageInstruction} ${modeInstruction} Commands execute under Windows cmd.exe; when using cmd built-ins such as dir, type, copy, or del, use backslashes for paths or quote absolute paths.`,
			customPrompt ? `Additional user-defined instructions:\n${customPrompt}` : "",
		]
			.filter(Boolean)
			.join("\n\n")

		this.logger.log("sidecar", "sdkConfig", {
			providerId: sdkProviderId,
			modelId,
			baseUrl: sdkBaseUrl || undefined,
			mode: this.state.mode,
			maxTokensPerTurn,
			apiTimeoutMs,
			thinking,
			reasoningEffort,
			contextWindowTokens,
			useAutoCondense: this.state.useAutoCondense === true,
			sessionId: sessionId || undefined,
			maxIterations,
			maxParallelToolCalls,
			subagentsEnabled,
			scheduledAgentsEnabled,
			oauthConfigured: Object.keys(oauthCredentials).length > 0,
			execution,
			preferredLanguage,
		})

		return {
			providerId: sdkProviderId,
			modelId,
			sessionId: sessionId || undefined,
			apiKey,
			baseUrl: sdkBaseUrl || undefined,
			cwd,
			workspaceRoot: cwd,
			mode: this.state.mode === "plan" ? "plan" : "act",
			enableTools: true,
			enableSpawnAgent: subagentsEnabled,
			enableAgentTeams: subagentsEnabled,
			...(maxIterations ? { maxIterations } : {}),
			...(maxParallelToolCalls ? { maxParallelToolCalls } : {}),
			...(maxTokensPerTurn ? { maxTokensPerTurn } : {}),
			...(apiTimeoutMs ? { apiTimeoutMs } : {}),
			thinking,
			reasoningEffort,
			providerConfig: {
				...(maxTokensPerTurn ? { maxTokens: maxTokensPerTurn } : {}),
				...(apiTimeoutMs ? { timeout: apiTimeoutMs } : {}),
				...(Object.keys(oauthCredentials).length > 0 ? { oauthCredentials } : {}),
				reasoning: {
					enabled: thinking,
					effort: reasoningEffort,
				},
			},
			checkpoint: {
				enabled: this.state.enableCheckpointsSetting !== false,
			},
			compaction: {
				enabled: this.state.useAutoCondense === true,
				strategy: "basic",
				thresholdRatio: 0.9,
				...(contextWindowTokens ? { maxInputTokens: contextWindowTokens } : {}),
			},
			...(execution ? { execution } : {}),
			preferredLanguage,
			systemPrompt,
		}
	}

	private addAssistantTextResult(text: string) {
		this.clearTaskIdleWatchdog()
		this.clearPartialIdleWatchdog()
		this.finalizeActivePartialText()
		this.finishActiveToolActivity()
		this.finishFoldedReasoningText()
		const normalizedText = normalizeAssistantTranscriptText(text || "")
		if (!normalizedText) {
			return
		}
		this.markSendLatencyFirstAssistant(this.getCurrentSessionId(), normalizedText.length)

		const lastText = [...this.state.clineMessages]
			.reverse()
			.find((message) => message.say === "text" && message.partial !== true)
		if (normalizeTranscriptText(getString(lastText, "text")) === normalizeTranscriptText(normalizedText)) {
			return
		}

		this.addMessage({ type: "say", say: "text", text: normalizedText })
	}

	private hasCompletionResult() {
		return this.state.clineMessages.some((message) => message.say === "completion_result" || message.ask === "completion_result")
	}

	private getLastUserMessageIndex() {
		return findLastIndex(
			this.state.clineMessages,
			(message) => getString(message, "say") === "user_feedback" || getString(message, "say") === "task",
		)
	}

	private hasCompletionResultAfterLastUserMessage() {
		const lastUserIndex = this.getLastUserMessageIndex()
		return this.state.clineMessages
			.slice(lastUserIndex + 1)
			.some((message) => getString(message, "say") === "completion_result" || getString(message, "ask") === "completion_result")
	}

	private getLastUserOrProgressMessageIndex() {
		return findLastIndex(this.state.clineMessages, (message) => {
			const say = getString(message, "say")
			const ask = getString(message, "ask")
			if (say === "user_feedback" || say === "task") {
				return true
			}
			if (ask === "command" || ask === "tool") {
				return true
			}
			if (say === "tool" || say === "command_output" || say === "browser_action") {
				return true
			}
			if (say === "reasoning") {
				const text = getString(message, "text")
				return text.includes("기록") || text.includes("history") || text.includes("진행") || text.includes("Running")
			}
			return false
		})
	}

	private hasAssistantTextAfterLastUserOrProgressMessage() {
		const lastBoundaryIndex = this.getLastUserOrProgressMessageIndex()
		return this.state.clineMessages
			.slice(lastBoundaryIndex + 1)
			.some((message) => getString(message, "say") === "text" && getString(message, "text").trim().length > 0 && message.partial !== true)
	}

	private finishSdkTask(sessionId: string, status: string, text = "") {
		this.transitionTask(isFailedTaskStatus(status) ? "failed" : "completed", `finish:${status || "completed"}`)
		this.clearTaskIdleWatchdog()
		this.clearPartialIdleWatchdog()
		this.clearReasoningStatus()
		const activeText = text || this.getActivePartialText()
		this.finalizeActivePartialText()
		this.finishActiveToolActivity()
		this.finishFoldedReasoningText()

		const hasAssistantTextSinceUser = this.hasAssistantTextAfterLastUserMessage()
		const hasFinalAssistantText = this.hasAssistantTextAfterLastUserOrProgressMessage()
		if (activeText) {
			this.addAssistantTextResult(activeText)
		} else if (!hasAssistantTextSinceUser) {
			this.logger.log("sidecar", "emptyDoneNoFinalAssistantText", { status, lastTaskActivityReason: (this.taskActivity?.reason || "") })
			const normalizedStatus = String(status || "").toLowerCase()
			if (normalizedStatus === "completed" || normalizedStatus === "idle" || normalizedStatus === "ended") {
				this.finalizeOpenPartialMessages()
				this.stateStore.save(createPersistedStateSnapshot(this.state))
				return
			}
		} else if (!hasFinalAssistantText) {
			this.logger.log("sidecar", "doneWithPreviousAssistantTextNoFinalText", { status, lastTaskActivityReason: (this.taskActivity?.reason || "") })
		} else {
			this.logger.log("sidecar", "doneWithExistingAssistantText", { status, lastTaskActivityReason: (this.taskActivity?.reason || "") })
		}
		this.finalizeOpenPartialMessages()
		this.addCompletionResultMarker(status)
		void this.runLifecycleHooks("TaskComplete", { sessionId, status, text: activeText })
		this.stateStore.save(createPersistedStateSnapshot(this.state))
	}

	private failSdkTaskWithMessage(sessionId: string, text: string) {
		this.transitionTask("failed", "finish:empty-model-response")
		this.clearTaskIdleWatchdog()
		this.clearPartialIdleWatchdog()
		this.clearReasoningStatus()
		this.finalizeActivePartialText()
		this.finishActiveToolActivity()
		this.finishFoldedReasoningText()
		this.finalizeOpenPartialMessages()
		this.addMessage({ type: "say", say: "error", text })
		void this.runLifecycleHooks("TaskComplete", { sessionId, status: "failed", text })
		this.stateStore.save(createPersistedStateSnapshot(this.state))
	}

	private addCompletionResultMarker(status: string) {
		if (this.hasCompletionResultAfterLastUserMessage()) {
			return
		}

		const normalizedStatus = String(status || "").toLowerCase()
		const uiLanguage = this.getUiLanguage()
		const text =
			normalizedStatus === "cancelled" || normalizedStatus === "stopped" || normalizedStatus === "aborted"
				? uiLanguage === "ko" ? "요청을 취소했습니다." : "Request cancelled."
				: normalizedStatus === "failed" || normalizedStatus === "error"
					? uiLanguage === "ko" ? "작업이 오류 상태로 종료되었습니다." : "Task ended with an error."
					: uiLanguage === "ko" ? "완료" : "Done."
		this.addMessage({ type: "say", say: "completion_result", text })
	}

	getUiLanguage(): "en" | "ko" {
		return getString(this.state, "uiLanguage") === "en" ? "en" : "ko"
	}

	private hasAssistantTextAfterLastUserMessage() {
		const lastUserIndex = this.getLastUserMessageIndex()
		return this.state.clineMessages
			.slice(lastUserIndex + 1)
			.some((message) => getString(message, "say") === "text" && getString(message, "text").trim().length > 0 && message.partial !== true)
	}

	private buildTerminalCompletionFallback(status: string) {
		const toolSummary = this.conversationProjection.recentToolSummaries(5).join("\n")
		if (status === "failed" || status === "error") {
			return toolSummary ? `작업이 오류 상태로 종료되었습니다.\n\n${toolSummary}` : "작업이 오류 상태로 종료되었습니다."
		}
		if (status === "stalled" || status === "idle-timeout") {
			return toolSummary
				? `LIG VS SDK가 일정 시간 새 진행 이벤트를 보내지 않아 작업을 중단했습니다.\n\n마지막으로 확인된 작업:\n${toolSummary}`
				: "LIG VS SDK가 일정 시간 새 진행 이벤트를 보내지 않아 작업을 중단했습니다."
		}
		if (status === "cancelled" || status === "stopped" || status === "aborted") {
			return toolSummary ? `작업이 중단되었습니다.\n\n${toolSummary}` : "작업이 중단되었습니다."
		}
		return toolSummary ? `작업이 완료되었습니다.\n\n${toolSummary}` : "작업이 완료되었습니다."
	}

	private rememberToolSummary(tool: string, text: string) {
		const parsed = asRecord(tryParseJson(text) ?? {})
		const pathValue = getString(parsed, "path")
		const content = getString(parsed, "content")
		const summary = [tool, pathValue, content].filter(Boolean).join(": ")
		this.conversationProjection.rememberToolSummary(truncateText(summary || text, 2000))
	}

	private async resolveEffectiveModelId(
		apiConfig: Record<string, unknown>,
		providerId: string,
		modePrefix: string,
		baseUrl: string,
	) {
		let modelId = resolveModelId(apiConfig, providerId, modePrefix)
		if (providerId !== "ollama") {
			return modelId || process.env.CLINE_MODEL_ID || "claude-sonnet-4-6"
		}

		if (!modelId || modelId === "claude-sonnet-4-6") {
			modelId = process.env.OLLAMA_MODEL || process.env.CLINE_MODEL_ID || ""
		}

		if (!modelId || modelId === "claude-sonnet-4-6") {
			const models = await getOllamaModels(baseUrl)
			modelId = models[0] || ""
			if (modelId) {
				this.applyDefaultOllamaModel(modelId)
			}
		}

		if (!modelId || modelId === "claude-sonnet-4-6") {
			throw new Error(
				`No local Ollama model is configured. Start Ollama and pull a model, for example: ollama pull llama3.1. Base URL: ${baseUrl || "http://localhost:11434"}`,
			)
		}

		return modelId
	}

	private applySettings(message: unknown) {
		const request = asRecord(message)
		let runtimeSettingsChanged = false
		const apiConfigurationUpdate = extractApiConfigurationUpdate(request)
		if (Object.keys(apiConfigurationUpdate).length > 0) {
			this.state.apiConfiguration = normalizeApiConfiguration({
				...this.state.apiConfiguration,
				...compactApiConfiguration(apiConfigurationUpdate),
			}) as typeof this.state.apiConfiguration
			this.apiConfigurationProfiles.syncActive()
			runtimeSettingsChanged = true
		}
		const autoApprovalUpdate = extractAutoApprovalSettingsUpdate(request)
		if (Object.keys(autoApprovalUpdate).length > 0) {
			this.state.autoApprovalSettings = {
				...this.state.autoApprovalSettings,
				...autoApprovalUpdate,
				actions: {
					...asRecord(this.state.autoApprovalSettings.actions),
					...asRecord(autoApprovalUpdate.actions),
				},
			}
			runtimeSettingsChanged = true
		}
		if ("browserSettings" in request) {
			this.state.browserSettings = {
				...asRecord(this.state.browserSettings),
				...asRecord(request.browserSettings),
			} as typeof this.state.browserSettings
			this.refreshWebToolFeatureState()
			runtimeSettingsChanged = true
		}
		if ("focusChainSettings" in request) {
			this.state.focusChainSettings = {
				...asRecord(this.state.focusChainSettings),
				...asRecord(request.focusChainSettings),
			} as typeof this.state.focusChainSettings
		}
		if ("mcpDisplayMode" in request) {
			this.state.mcpDisplayMode = normalizeMcpDisplayMode(request.mcpDisplayMode, this.state.mcpDisplayMode)
		}
		for (const key of [
			"apiConfiguration",
			"autoApprovalSettings",
			"mode",
			"planActSeparateModelsSetting",
			"uiLanguage",
			"preferredLanguage",
			"telemetrySetting",
			"subagentsEnabled",
			"scheduledAgentsEnabled",
			"hooksEnabled",
			"showFeatureTips",
			"backgroundEditEnabled",
			"enableCheckpointsSetting",
			"yoloModeToggled",
			"doubleCheckCompletionEnabled",
			"lazyTeammateModeEnabled",
			"mcpResponsesCollapsed",
			"enableParallelToolCalling",
			"nativeToolCallEnabled",
			"strictPlanModeEnabled",
			"useAutoCondense",
			"customPrompt",
		] as const) {
			if (key in request && key !== "apiConfiguration" && key !== "autoApprovalSettings") {
				const stateKey = key === "nativeToolCallEnabled" ? "nativeToolCallSetting" : key
				;(this.state as Record<string, unknown>)[stateKey] = request[key]
				if (isRuntimeSettingsKey(key)) {
					runtimeSettingsChanged = true
				}
			}
		}
		if ("apiConfigurationProfiles" in request) {
			this.state.apiConfigurationProfiles = normalizeApiConfigurationProfiles(request.apiConfigurationProfiles, this.state.apiConfiguration, this.state.planActSeparateModelsSetting)
			runtimeSettingsChanged = true
		}
		if ("activeApiConfigurationProfileId" in request) {
			this.apiConfigurationProfiles.activate(getString(request, "activeApiConfigurationProfileId"))
			runtimeSettingsChanged = true
		} else if ("apiConfigurationProfiles" in request) {
			this.apiConfigurationProfiles.ensure()
		}
		if ("planActSeparateModelsSetting" in request && !("activeApiConfigurationProfileId" in request)) {
			this.apiConfigurationProfiles.syncActive()
			runtimeSettingsChanged = true
		}
		if (runtimeSettingsChanged) {
			this.runtimeSettingsRevision++
			this.logger.log("sidecar", "runtimeSettingsChanged", {
				runtimeSettingsRevision: this.runtimeSettingsRevision,
				activeSessionRuntimeSettingsRevision: this.activeSessionRuntimeSettingsRevision,
			})
		}
	}

	private refreshWebToolFeatureState() {
		const enabled = isWebFetchEnabled(this.state.browserSettings)
		this.state.clineWebToolsEnabled = {
			user: enabled,
			featureFlag: enabled,
			reason: webFetchDisabledReason(this.state.browserSettings) || undefined,
		}
	}

	applyDefaultOllamaModel(modelId: string) {
		const apiConfiguration = this.state.apiConfiguration as Record<string, unknown>
		let changed = false

		if (
			apiConfiguration.actModeApiProvider === "ollama" &&
			(typeof apiConfiguration.actModeOllamaModelId !== "string" || !apiConfiguration.actModeOllamaModelId.trim())
		) {
			apiConfiguration.actModeOllamaModelId = modelId
			changed = true
		}
		if (
			apiConfiguration.planModeApiProvider === "ollama" &&
			(typeof apiConfiguration.planModeOllamaModelId !== "string" || !apiConfiguration.planModeOllamaModelId.trim())
		) {
			apiConfiguration.planModeOllamaModelId = modelId
			changed = true
		}

		if (changed) {
			this.stateStore.save(createPersistedStateSnapshot(this.state))
			this.broadcastState().catch((error) => console.error(error))
		}
	}

	private addMessage(message: Record<string, unknown>) {
		if (isMeaninglessPlaceholderMessage(message)) {
			this.logger.log("sidecar", "skipMeaninglessPlaceholderMessage", message)
			return undefined
		}
		if (isMeaninglessTextMessage(message)) {
			this.logger.log("sidecar", "skipMeaninglessTextMessage", message)
			return undefined
		}
		if (isMeaninglessToolMessage(message)) {
			this.logger.log("sidecar", "skipMeaninglessToolMessage", message)
			return undefined
		}
		const normalizedMessage = {
			ts: Date.now() + this.messageSequence++,
			...normalizeClineMessagePayload(message),
		}
		this.state.clineMessages.push(normalizedMessage)
		this.schedulePersistedStateSave()
		return normalizedMessage
	}

	private removeTerminalAskMessages() {
		this.state.clineMessages = this.state.clineMessages.filter((message) => {
			const ask = getString(message, "ask")
			return ask !== "completion_result" && ask !== "resume_task" && ask !== "resume_completed_task"
		})
		this.schedulePersistedStateSave()
	}

	private removeAskMessages(askKind: string) {
		this.state.clineMessages = this.state.clineMessages.filter((message) => getString(message, "ask") !== askKind)
		this.schedulePersistedStateSave()
	}

	private addToolActivityMessage(tool: string, input: Record<string, unknown>, fallback: unknown) {
		this.recordToolActivity(
			tool,
			JSON.stringify({
				tool,
				path: tool === "searchFiles" ? getToolPath(input) || "/" : getToolPathFromUnknown(input),
				regex: tool === "searchFiles" ? getSearchQuery(input) : undefined,
				filePattern: tool === "searchFiles" ? getSearchFilePattern(input) : undefined,
				command: tool === "executeCommand" ? getCommandText(input) : undefined,
				content: summarizeToolInput(input) || stringify(fallback),
			}),
		)
	}

	private recordToolActivity(tool: string, text: string) {
		const entries = toolActivityEntriesFromMessage(tool, text)
		if (entries.length === 0) {
			return
		}

		const activeEntries = this.conversationProjection.mergeToolActivities(entries, toolActivityEntryKey)
		const groupedText = buildGroupedToolActivityText(activeEntries, true, this.getUiLanguage())
		this.upsertFoldedActivityText(groupedText)
	}

	private startTerminalStatePolling() {
		this.requireTerminalActivity().start()
	}

	private stopTerminalStatePolling() {
		this.terminalActivity?.stop()
	}

	private async pollTerminalState() {
		await this.requireTerminalActivity().poll()
	}

	private finishActiveToolActivity() {
		const entries = this.conversationProjection.finishToolActivities()
		if (entries.length === 0) return
		const groupedText = buildGroupedToolActivityText(entries, false, this.getUiLanguage())
		this.upsertFoldedActivityText(groupedText)
	}



	private finalizeActivePartialText() {
		this.partialTextProjector.finalize()
	}

	private getActivePartialText() {
		return this.partialTextProjector.activeText()
	}

	private upsertPartialText(text: string) {
		this.partialTextProjector.upsert(text)
	}

	private upsertAssistantTextFromEvent(accumulated: string, delta: string) {
		const nextText = accumulated || mergeTextDelta(this.conversationProjection.activeAssistantTextBuffer, delta)
		const normalized = normalizeAssistantTranscriptText(nextText)
		if (!normalized) {
			return
		}
		this.markSendLatencyFirstAssistant(this.getCurrentSessionId(), normalized.length)

		this.conversationProjection.activeAssistantTextBuffer = normalized
		if (shouldFoldTextContentAsReasoning(normalized)) {
			this.upsertFoldedReasoningText(normalized)
			return
		}
		if (!accumulated && shouldDelayAssistantTextUntilClassified(normalized)) {
			this.schedulePartialIdleWatchdog()
			this.schedulePartialStateBroadcast()
			return
		}
		this.finishActiveToolActivity()
		this.finishFoldedReasoningText()
		this.upsertPartialText(normalized)
	}

	private completeAssistantText(text: string) {
		this.finishActiveToolActivity()
		this.finishFoldedReasoningText()
		const timestamp = this.conversationProjection.activePartialTextTs
		if (timestamp) {
			this.upsertMessage(timestamp, { type: "say", say: "text", text, partial: false })
			this.sendPartialMessage(this.state.clineMessages.find((message) => message.ts === timestamp))
			this.conversationProjection.activePartialTextTs = null
		} else this.addMessage({ type: "say", say: "text", text })
		this.conversationProjection.activeAssistantTextBuffer = ""
	}

	private upsertFoldedReasoningText(text: string) { this.foldedProgressProjector.upsertReasoning(text) }



	private upsertFoldedActivityText(text: string) { this.foldedProgressProjector.upsertActivity(text) }

	private appendTerminalActivityText(text: string) { this.foldedProgressProjector.appendTerminal(text) }



	private finishFoldedReasoningText(stopTerminalPolling = true) { this.foldedProgressProjector.finish(stopTerminalPolling) }



	private startSendLatencyTrace(requestId: string, kind: "newTask" | "askResponse", sessionId: string, textLength: number) { this.requireSendLatency().start(requestId, kind, sessionId, textLength) }

	private markSendLatencySdkSend(sessionId: string) { this.requireSendLatency().markSdkSend(sessionId) }

	private markSendLatencyFirstSdkEvent(sessionId: string, eventType: string) { this.requireSendLatency().markFirstSdkEvent(sessionId, eventType) }

	private markSendLatencyFirstAssistant(sessionId: string, textLength: number) { this.requireSendLatency().markFirstAssistant(sessionId, textLength) }

	private markSendLatencyError(sessionId: string, error: unknown) { this.requireSendLatency().markError(sessionId, error) }

	private rebindSendLatencyTrace(previousSessionId: string, nextSessionId: string) { this.requireSendLatency().rebind(previousSessionId, nextSessionId) }

	private getCurrentSessionId() {
		return this.clineSdk?.status.activeSessionId || String(this.state.currentTaskItem?.id || "")
	}

	private finalizeOpenPartialMessages() {
		this.clearPartialIdleWatchdog()
		this.clearPartialStateBroadcastTimer()
		this.stopTerminalStatePolling()
		let changed = false
		this.state.clineMessages = this.state.clineMessages.filter((message) => {
			if (message.partial !== true) {
				return true
			}

			if (message.say === "api_req_started" && isPlaceholderApiRequest(getString(message, "text"))) {
				changed = true
				return false
			}

			message.partial = false
			if (message.say === "api_req_started" || message.say === "reasoning") {
				message.isCollapsed = true
				message.isExpanded = false
			}
			this.sendPartialMessage(message)
			changed = true
			return true
		})
		if (changed) {
			this.logger.log("sidecar", "finalizedOpenPartials", {})
		}
		this.conversationProjection.activePartialTextTs = null
		this.conversationProjection.finishProgressMessage()
	}

	private schedulePartialIdleWatchdog() {
		this.requirePartialStateScheduler().scheduleIdle()
	}

	private clearPartialIdleWatchdog() {
		this.partialStateScheduler?.clearIdle()
	}

	private clearPartialStateBroadcastTimer() {
		this.partialStateScheduler?.clearBroadcast()
	}

	private broadcastPartialStateNow() {
		this.requirePartialStateScheduler().broadcastNow()
	}

	private schedulePartialStateBroadcast() {
		this.requirePartialStateScheduler().scheduleBroadcast()
	}

	private noteTaskActivity(reason: string) {
		const terminal = this.hasCompletionResultAfterLastUserMessage() || isTerminalTaskStatus(reason) || reason === "done" || reason === "ended" || reason === "run-finished"
		this.requireTaskActivity().note(reason, terminal)
		if (terminal) {
			this.clearPartialIdleWatchdog()
			this.clearPartialStateBroadcastTimer()
		}
	}

	private noteQuietTaskActivity(reason: string) {
		this.requireTaskActivity().quiet(reason)
	}

	private clearTaskIdleWatchdog() {
		this.taskActivity?.clear()
	}

	private shouldIgnoreSdkEvent(sessionId: string) {
		if (!sessionId) {
			return false
		}
		if (this.closingSessionIds.has(sessionId)) {
			return true
		}
		if (!this.state.currentTaskItem) {
			return true
		}
		const activeSessionId = this.clineSdk?.status.activeSessionId
		if (activeSessionId) {
			return sessionId !== activeSessionId
		}
		const currentTaskId = String(this.state.currentTaskItem?.id || "")
		return !!currentTaskId && sessionId !== currentTaskId
	}

	private bindCurrentTaskToSession(sessionId: string) {
		this.taskLifecycle.bindSession(sessionId)
		if (!sessionId || !this.state.currentTaskItem) {
			return
		}
		const currentTaskId = String(this.state.currentTaskItem.id || "")
		if (!currentTaskId || currentTaskId === sessionId) {
			return
		}

		const snapshot = this.getTaskSnapshot(currentTaskId)
		if (snapshot) {
			this.forgetTaskSnapshot(currentTaskId)
			this.rememberTaskSnapshot(sessionId, snapshot.taskItem, snapshot.messages)
		}
		this.state.currentTaskItem = { ...this.state.currentTaskItem, id: sessionId }
		this.state.taskHistory = rebindTaskHistoryId(this.state.taskHistory, currentTaskId, sessionId)
		this.rebindSendLatencyTrace(currentTaskId, sessionId)
		this.logger.log("sidecar", "taskSessionIdRebound", { previousTaskId: currentTaskId, sessionId })
	}

	private transitionTask(status: TaskLifecycleStatus, source: string) {
		const transition = this.taskLifecycle.transition(status, source)
		if (!transition.accepted) {
			this.logger.log("sidecar", "taskLifecycleTransitionRejected", transition)
			return false
		}
		this.state.taskLifecycleStatus = transition.current
		if (transition.previous !== transition.current) {
			this.logger.log("sidecar", "taskLifecycleTransition", transition)
		}
		return true
	}

	private upsertMessage(ts: number, updates: Record<string, unknown>) {
		const index = this.state.clineMessages.findIndex((message) => message.ts === ts)
		if (index >= 0) {
			const normalized = normalizeClineMessagePayload({ ...this.state.clineMessages[index], ...updates, ts })
			if (isMeaninglessPlaceholderMessage(normalized) || isMeaninglessToolMessage(normalized) || isMeaninglessTextMessage(normalized)) {
				this.state.clineMessages.splice(index, 1)
			} else {
				this.state.clineMessages[index] = normalized
			}
			this.schedulePersistedStateSave()
		}
	}

	private updateCurrentTaskItem(updates?: Record<string, unknown>) {
		if (!this.state.currentTaskItem) {
			return
		}

		this.state.currentTaskItem = {
			...this.state.currentTaskItem,
			...updates,
			ts: Date.now(),
			size: this.state.clineMessages.length,
		}
		this.state.taskHistory = upsertTaskHistoryItem(this.state.taskHistory, this.state.currentTaskItem)
		this.rememberTaskSnapshot(String(this.state.currentTaskItem.id || ""), this.state.currentTaskItem, this.state.clineMessages)
		this.schedulePersistedStateSave()
	}

	private getTaskSnapshot(taskId: string) {
		return this.taskSnapshots.get(taskId)
	}

	private rememberTaskSnapshot(taskId: string, taskItem: Record<string, unknown>, messages: Array<Record<string, unknown>>) {
		this.taskSnapshots.remember(taskId, taskItem, messages)
	}

	private forgetTaskSnapshot(taskId: string) {
		this.taskSnapshots.forget(taskId)
	}

	private clearTaskSnapshots() {
		this.taskSnapshots.clear()
	}

	private getModelId() {
		const apiConfig = asRecord(this.state.apiConfiguration)
		const { modePrefix, providerId } = selectProvider(apiConfig, this.state.mode)
		if (providerId === "ollama") {
			return resolveModelId(apiConfig, providerId, modePrefix) || process.env.OLLAMA_MODEL || process.env.CLINE_MODEL_ID || "ollama"
		}

		return resolveModelId(apiConfig, providerId, modePrefix) || process.env.CLINE_MODEL_ID || "claude-sonnet-4-6"
	}

	private getResumedConversationCharBudget() {
		const apiConfig = asRecord(this.state.apiConfiguration)
		const modePrefix = this.state.mode === "plan" ? "planMode" : "actMode"
		const providerId = normalizeProviderId(getString(apiConfig, `${modePrefix}ApiProvider`) || "anthropic")
		const modelId = this.getModelId()
		const contextWindowTokens = resolveConfiguredContextWindow(apiConfig, providerId, modePrefix, modelId)
		return contextWindowTokens
			? Math.min(RESUMED_CONVERSATION_MAX_CHARS, Math.max(2_000, Math.floor(contextWindowTokens * 0.5)))
			: RESUMED_CONVERSATION_MAX_CHARS
	}

	private createCurrentModelCatalog() {
		return this.requireProviderModelCatalogs().current(asRecord(this.state.apiConfiguration), this.state.mode, this.getModelId())
	}

	private schedulePersistedStateSave() {
		this.stateStore.schedule(() => createPersistedStateSnapshot(this.state))
	}

	private flushPersistedStateSave() {
		this.stateStore.flush(() => createPersistedStateSnapshot(this.state))
	}

	private async createProviderModelCatalog(providerId: string, request: Record<string, unknown>) {
		return this.requireProviderModelCatalogs().refresh(providerId, request, asRecord(this.state.apiConfiguration), this.state.mode, this.getModelId())
	}

	private createUnsupportedModelCatalog(key: string) {
		return this.requireProviderModelCatalogs().unsupported(key)
	}

	private async broadcastState() { await this.requireStreamPublisher().broadcastState() }

	private buildStateMessages() { return this.requireStreamPublisher().buildStateMessages() }

	private sendPartialMessage(message: Record<string, unknown> | undefined) { this.requireStreamPublisher().sendPartial(message) }

	private refreshStateStreamsInBackground() {
		if (this.stateHydrationRefreshInFlight) {
			return
		}
		this.stateHydrationRefreshInFlight = true
		void (async () => {
			try {
				await this.taskHistorySync.refresh()
				await this.refreshSelectedTaskFromSdk()
				await this.broadcastState()
			} catch (error) {
				this.logger.log("sidecar", "stateHydrationRefreshFailed", { error: stringify(error) })
			} finally {
				this.stateHydrationRefreshInFlight = false
			}
		})()
	}

	private scheduleStateStreamsRefresh() {
		const delayMs = readPositiveIntEnv("VSCLINE_STATE_REFRESH_DELAY_MS", 2500)
		setTimeout(() => {
			if (this.state.currentTaskItem && this.clineSdk?.status.activeSessionId) {
				return
			}
			this.refreshStateStreamsInBackground()
		}, delayMs).unref?.()
	}
}

function shouldLogSdkEventForInteraction(event: unknown) {
	const record = asRecord(event)
	const type = getString(record, "type")
	if (type !== "chunk") {
		return true
	}

	const payload = asRecord(record.payload)
	if (getString(payload, "stream") !== "agent") {
		return true
	}

	const chunkRecord = sdkChunkRecord(payload.chunk)
	const chunkType = getString(chunkRecord, "type")
	const contentType = getString(chunkRecord, "contentType")
	return !(
		(chunkType === "content_start" || chunkType === "content_update" || chunkType === "content_delta") &&
		(contentType === "reasoning" || contentType === "text")
	)
}

function sdkChunkRecord(chunk: unknown) {
	if (typeof chunk === "string") {
		return asRecord(tryParseJson(chunk) ?? {})
	}
	return asRecord(chunk)
}

function summarizeSdkEventForLog(event: unknown) {
	const record = asRecord(event)
	const type = getString(record, "type")
	const payload = asRecord(record.payload)
	if (type === "agent_event") {
		return {
			type,
			sessionId: getString(payload, "sessionId"),
			event: summarizeAgentChunkForLog(payload.event),
		}
	}
	if (type === "chunk") {
		return {
			type,
			sessionId: getString(payload, "sessionId"),
			stream: getString(payload, "stream"),
			chunk: summarizeAgentChunkForLog(payload.chunk),
		}
	}
	if (type === "session_snapshot") {
		const snapshot = asRecord(payload.snapshot)
		return {
			type,
			sessionId: getString(payload, "sessionId"),
			status: getString(snapshot, "status"),
			messageCount: getNumber(snapshot, "messageCount"),
		}
	}
	return event
}

function summarizeAgentChunkForLog(value: unknown) {
	if (typeof value === "string") {
		return { kind: "string", length: value.length, preview: truncateText(value, 240) }
	}
	const record = asRecord(value)
	if (Object.keys(record).length === 0) {
		return { kind: typeof value }
	}
	return {
		type: getString(record, "type"),
		contentType: getString(record, "contentType"),
		toolName: getString(record, "toolName"),
		textLength: getString(record, "text").length,
		accumulatedLength: getString(record, "accumulated").length,
		reasoningLength: getString(record, "reasoning").length,
		hasInput: Object.keys(asRecord(record.input)).length > 0,
		hasOutput: record.output !== undefined,
		hasUsage: record.usage !== undefined,
	}
}

function summarizeClineMessageForLog(message: Record<string, unknown>) {
	const text = getString(message, "text")
	return {
		ts: getNumber(message, "ts"),
		type: getString(message, "type"),
		say: getString(message, "say"),
		ask: getString(message, "ask"),
		partial: message.partial === true,
		textLength: text.length,
		textPreview: truncateText(text, 240),
	}
}

function readRequestId(message: unknown) {
	const record = asRecord(message)
	return getString(record, "request_id") || getString(record, "requestId")
}

function getString(message: unknown, key: string): string {
	if (typeof message !== "object" || message === null || !(key in message)) {
		return ""
	}

	const value = (message as Record<string, unknown>)[key]
	return typeof value === "string" ? value : ""
}

function getStringArray(message: unknown, key: string): string[] {
	const record = asRecord(message)
	const value = record[key]
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function getBoolean(message: unknown, key: string): boolean | undefined {
	const record = asRecord(message)
	const value = record[key]
	return typeof value === "boolean" ? value : undefined
}

function isFailedTaskStatus(status: string) {
	const normalized = status.trim().toLowerCase()
	return normalized === "failed" || normalized === "error"
}

function normalizePromptDelivery(value: string): "queue" | "steer" | undefined {
	return value === "queue" || value === "steer" ? value : undefined
}

function getNumber(message: unknown, key: string): number | undefined {
	const record = asRecord(message)
	const value = record[key]
	return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function truncateForStatus(value: string, maxLength: number) {
	const normalized = value.replace(/\s+/g, " ").trim()
	return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}...`
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
	return Array.isArray(value) ? value.map(asRecord).filter((item) => Object.keys(item).length > 0) : []
}

function numberValue(value: unknown) {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function booleanValue(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined
}

function readPositiveIntEnv(name: string, fallback: number) {
	const raw = process.env[name]
	if (!raw) {
		return fallback
	}

	const value = Number.parseInt(raw, 10)
	return Number.isFinite(value) && value > 0 ? value : fallback
}

function readOptionalPositiveIntEnv(name: string) {
	const raw = process.env[name]
	if (!raw) {
		return undefined
	}

	const value = Number.parseInt(raw, 10)
	return Number.isFinite(value) && value > 0 ? value : undefined
}

function resolveRequestTimeoutMs(apiConfig: Record<string, unknown>) {
	const configured =
		numberValue(apiConfig.requestTimeoutMs) ||
		numberValue(apiConfig.apiTimeoutMs) ||
		numberValue(apiConfig.openAiRequestTimeoutMs) ||
		numberValue(apiConfig.openAiCompatibleRequestTimeoutMs)
	return configured && configured > 0 ? configured : readPositiveIntEnv("VSCLINE_API_TIMEOUT_MS", 600_000)
}

function resolveReasoningEffort(apiConfig: Record<string, unknown>, modePrefix: string) {
	const candidates = [
		getString(apiConfig, `${modePrefix}ReasoningEffort`),
		getString(apiConfig, `${modePrefix}OpenAiReasoningEffort`),
		getString(apiConfig, "reasoningEffort"),
		getString(apiConfig, "openAiReasoningEffort"),
		getString(apiConfig, "openAiCompatibleReasoningEffort"),
	]
		.map((value) => value.trim().toLowerCase())
		.filter(Boolean)

	for (const candidate of candidates) {
		if (candidate === "low" || candidate === "medium" || candidate === "high" || candidate === "xhigh" || candidate === "none") {
			return candidate
		}
	}

	return process.env.VSCLINE_REASONING_EFFORT as "low" | "medium" | "high" | "xhigh" | "none" | undefined
}

function resolveThinkingEnabled(
	apiConfig: Record<string, unknown>,
	modePrefix: string,
	providerId: string,
	reasoningEffort?: string,
): boolean | undefined {
	const candidates = [
		booleanValue(apiConfig[`${modePrefix}EnableThinking`]),
		booleanValue(apiConfig[`${modePrefix}ThinkingEnabled`]),
		booleanValue(apiConfig.enableThinking),
		booleanValue(apiConfig.thinking),
		booleanValue(apiConfig.openAiThinkingEnabled),
		booleanValue(apiConfig.openAiCompatibleThinkingEnabled),
	].filter((value): value is boolean => value !== undefined)

	if (candidates.length > 0) {
		return candidates[0]
	}

	if (reasoningEffort === "none") {
		return false
	}
	if (reasoningEffort) {
		return true
	}
	if (providerId === "openai" || providerId === "openai-compatible") {
		return false
	}
	return undefined
}

function buildOptionalExecutionConfig() {
	const execution: Record<string, unknown> = {}
	const maxConsecutiveMistakes = readOptionalPositiveIntEnv("VSCLINE_MAX_CONSECUTIVE_MISTAKES")
	const reminderAfterIterations = readOptionalPositiveIntEnv("VSCLINE_REMINDER_AFTER_ITERATIONS")
	const loopDetection = readLoopDetectionConfig()
	if (maxConsecutiveMistakes) {
		execution.maxConsecutiveMistakes = maxConsecutiveMistakes
	}
	if (reminderAfterIterations) {
		execution.reminderAfterIterations = reminderAfterIterations
	}
	if (loopDetection !== undefined) {
		execution.loopDetection = loopDetection
	}
	return Object.keys(execution).length > 0 ? execution : undefined
}

function readLoopDetectionConfig() {
	const rawValue = process.env.VSCLINE_LOOP_DETECTION
	if (!rawValue) {
		return undefined
	}
	const raw = rawValue.trim().toLowerCase()
	if (raw === "0" || raw === "false" || raw === "off") {
		return false
	}

	return {
		softThreshold: readOptionalPositiveIntEnv("VSCLINE_LOOP_SOFT_THRESHOLD") || 3,
		hardThreshold: readOptionalPositiveIntEnv("VSCLINE_LOOP_HARD_THRESHOLD") || 5,
	}
}

function isSessionNotFoundError(error: unknown) {
	const message = error instanceof Error ? error.message : String(error)
	return /session not found/i.test(message)
}

function stringify(value: unknown): string {
	if (typeof value === "string") {
		return value
	}
	if (value instanceof Error) {
		const details = [value.name, value.message].filter(Boolean).join(": ")
		const errorWithCause = value as Error & { cause?: unknown }
		const cause: string = errorWithCause.cause === undefined ? "" : stringify(errorWithCause.cause)
		return cause ? `${details}\nCaused by: ${cause}` : details
	}
	try {
		const serialized = JSON.stringify(value)
		return serialized === "{}" ? String(value) : serialized
	} catch {
		return String(value)
	}
}

function formatEmptyModelResponseForUi(language: "en" | "ko") {
	return language === "ko"
		? "모델이 응답 본문을 생성하지 못했습니다. 선택한 모델이 Ollama에서 정상적으로 실행되는지 확인하거나 다른 모델로 다시 시도해 주세요."
		: "The model returned no response body. Verify that the selected model runs correctly in Ollama, or retry with another model."
}

function formatProviderErrorForTranscript(value: unknown, language: "en" | "ko") {
	const text = stringify(value).trim()
	if (!text) {
		return language === "ko" ? "모델 제공자가 빈 오류를 반환했습니다." : "The model provider returned an empty error."
	}
	if (/too many requests|rate limit|429/i.test(text)) {
		return language === "ko"
			? `모델 제공자 응답: 요청 한도를 초과했습니다.\n\n${text}`
			: `Model provider response: rate limit exceeded.\n\n${text}`
	}
	return text
}

function isPlaceholderApiRequest(text: string) {
	const parsed = asRecord(tryParseJson(text) ?? {})
	const request = getString(parsed, "request") || text
	const normalized = request.replace(/\s+/g, " ").trim().toLowerCase()
	return (
		normalized === "cline sdk is thinking..." ||
		normalized === "thinking" ||
		normalized === "모델 진행 중" ||
		normalized === "모델 진행 기록"
	)
}

function truncateText(value: string, maxChars: number) {
	if (value.length <= maxChars) {
		return value
	}
	return `${value.slice(0, maxChars)}\n\n[truncated ${value.length - maxChars} chars]`
}

function grpcHandled(...webviewMessages: unknown[]) {
	return {
		handled: true,
		owner: "sidecar",
		webviewMessages,
	}
}

function grpcResponse(requestId: string, message: unknown, isStreaming: boolean) {
	return {
		protocol_version: HOST_SIDECAR_WEBVIEW_PROTOCOL_VERSION,
		type: "grpc_response",
		grpc_response: {
			request_id: requestId,
			message,
			is_streaming: isStreaming,
		},
	}
}

function grpcError(requestId: string, error: string, isStreaming: boolean) {
	return {
		protocol_version: HOST_SIDECAR_WEBVIEW_PROTOCOL_VERSION,
		type: "grpc_response",
		grpc_response: {
			request_id: requestId,
			error,
			is_streaming: isStreaming,
		},
	}
}

function delay(ms: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function formatSdkErrorForUi(error: unknown, language: "en" | "ko") {
	const text = error instanceof Error ? error.message : String(error ?? "")
	if (text && text !== "[object Object]" && text !== "{}") {
		return text
	}

	return language === "en"
		? "The SDK request ended before a final response could be synchronized."
		: "SDK 요청이 최종 응답을 동기화하기 전에 종료되었습니다."
}
