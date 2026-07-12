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
import type { AgentRuntimeEvent, WorkspaceChange } from "../../domain/agent/AgentRuntimeEvent"
import type { ApprovalRequestedEvent } from "../../domain/agent/AgentRuntimeEvent"
import type { SendMessageHandler } from "../../features/chat/sendMessage/SendMessageHandler"
import type { StartTaskHandler } from "../../features/chat/startTask/StartTaskHandler"
import type { CancelTaskHandler } from "../../features/chat/cancelTask/CancelTaskHandler"
import { CancelTaskFlow } from "../../features/chat/cancelTask/CancelTaskFlow"
import { AgentRunRecoveryFlow } from "../../features/chat/runtime/AgentRunRecoveryFlow"
import { AgentRunCompletionFlow } from "../../features/chat/runtime/AgentRunCompletionFlow"
import { SendOrResumeSessionFlow } from "../../features/chat/runtime/SendOrResumeSessionFlow"
import { ResumeSessionFlow } from "../../features/chat/runtime/ResumeSessionFlow"
import { LaunchAgentSessionFlow } from "../../features/chat/runtime/LaunchAgentSessionFlow"
import { PrepareNewTaskFlow } from "../../features/chat/startTask/PrepareNewTaskFlow"
import { StartNewTaskFlow } from "../../features/chat/startTask/StartNewTaskFlow"
import { AskResponseInteractionFlow } from "../../features/chat/sendMessage/AskResponseInteractionFlow"
import { SendUserMessageFlow } from "../../features/chat/sendMessage/SendUserMessageFlow"
import { CompactSessionFlow } from "../../features/chat/runtime/CompactSessionFlow"
import { ClearTaskHandler } from "../../features/chat/clearTask/ClearTaskHandler"
import type { BrowserHandler, BrowserSettings } from "../../features/browser/BrowserHandler"
import type { WorktreeQueryHandler } from "../../features/worktrees/WorktreeQueryHandler"
import type { WorktreeMutationHandler } from "../../features/worktrees/WorktreeMutationHandler"
import type { OAuthAuthorizationHandler } from "../../features/providers/OAuthAuthorizationHandler"
import type { OAuthCallbackHandler } from "../../features/providers/OAuthCallbackHandler"
import type { ProviderCredentialHandler } from "../../features/providers/ProviderCredentialHandler"
import type { ProviderAuthActionHandler } from "../../features/providers/ProviderAuthActionHandler"
import { ApprovalCoordinator } from "../../features/approvals/ApprovalCoordinator"
import { ToolApprovalFlow } from "../../features/approvals/ToolApprovalFlow"
import { rebindTaskHistoryId, upsertTaskHistoryItem } from "../../features/taskHistory/TaskHistoryCollection"
import {
	isOAuthTokenBlobProvider,
	normalizeProviderId,
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
import { TaskStateCoordinator } from "../../features/taskHistory/TaskStateCoordinator"
import { TaskHistorySync } from "../../features/taskHistory/TaskHistorySync"
import { TaskHistoryCommands } from "../../features/taskHistory/TaskHistoryCommands"
import { TaskTranscriptHydrator } from "../../features/taskHistory/TaskTranscriptHydrator"
import type { SdkSettingsHandler } from "../../features/settings/SdkSettingsHandler"
import { AgentTextEventProjector } from "../conversation/AgentTextEventProjector"
import { AgentToolEventProjector } from "../conversation/AgentToolEventProjector"
import { AgentLifecycleEventProjector } from "../conversation/AgentLifecycleEventProjector"
import { AgentAuxiliaryEventProjector } from "../conversation/AgentAuxiliaryEventProjector"
import { AgentSnapshotEventProjector } from "../conversation/AgentSnapshotEventProjector"
import { AgentChunkEventProjector } from "../conversation/AgentChunkEventProjector"
import { TaskCompletionProjector } from "../conversation/TaskCompletionProjector"
import { RuntimeStatusEventProjector } from "../conversation/RuntimeStatusEventProjector"
import { AgentRuntimeEventDispatcher } from "../../features/runtime/AgentRuntimeEventDispatcher"
import { AgentEventDispatcher } from "../../features/runtime/AgentEventDispatcher"
import { RuntimeMonitoringCoordinator } from "../../features/runtime/RuntimeMonitoringCoordinator"
import { TaskSessionCoordinator } from "../../features/runtime/TaskSessionCoordinator"
import { ConversationMessageStore } from "../conversation/ConversationMessageStore"
import { ApiConfigurationProfileManager } from "../configuration/ApiConfigurationProfileManager"
import { SettingsMutationHandler } from "../configuration/SettingsMutationHandler"
import { SettingsRpcHandler } from "../../features/settings/SettingsRpcHandler"
import { decodeSettingsRpcCommand } from "./SettingsRpcDecoder"
import { AccountRpcHandler } from "../../features/providers/AccountRpcHandler"
import { decodeAccountRpcCommand } from "./AccountRpcDecoder"
import { BrowserRpcHandler } from "../../features/browser/BrowserRpcHandler"
import { decodeBrowserRpcCommand } from "./BrowserRpcDecoder"
import { TerminalRpcHandler } from "../../features/terminal/TerminalRpcHandler"
import { decodeTerminalRpcCommand } from "./TerminalRpcDecoder"
import { TaskRpcHandler, type TaskPromptRequest } from "../../features/chat/TaskRpcHandler"
import { decodeTaskRpcCommand } from "./TaskRpcDecoder"
import { CheckpointRpcHandler } from "../../features/checkpoints/CheckpointRpcHandler"
import { decodeCheckpointRpcCommand } from "./CheckpointRpcDecoder"
import { HookRpcHandler } from "../../features/hooks/HookRpcHandler"
import { decodeHookRpcCommand } from "./HookRpcDecoder"
import { ScheduledAgentRpcHandler } from "../../features/scheduledAgents/ScheduledAgentRpcHandler"
import { decodeScheduledAgentRpcCommand } from "./ScheduledAgentRpcDecoder"
import { WorktreeRpcHandler } from "../../features/worktrees/WorktreeRpcHandler"
import { decodeWorktreeRpcCommand } from "./WorktreeRpcDecoder"
import { McpRpcHandler } from "../../features/mcp/McpRpcHandler"
import { decodeMcpRpcCommand } from "./McpRpcDecoder"
import { ModelCatalogRpcHandler } from "../../features/providers/ModelCatalogRpcHandler"
import { decodeModelCatalogRpcCommand } from "./ModelCatalogRpcDecoder"
import { FileRpcHandler } from "../../features/files/FileRpcHandler"
import { decodeFileRpcCommand } from "./FileRpcDecoder"
import { InstructionSettingsRpcHandler } from "../../features/settings/InstructionSettingsRpcHandler"
import { decodeInstructionSettingsRpcCommand } from "./InstructionSettingsRpcDecoder"
import { UiWebRpcHandler } from "../../features/web/UiWebRpcHandler"
import { decodeUiWebRpcCommand } from "./UiWebRpcDecoder"
import { PluginRpcHandler } from "../../features/plugins/PluginRpcHandler"
import { decodePluginRpcCommand } from "./PluginRpcDecoder"
import { StreamingRpcHandler } from "../../features/web/StreamingRpcHandler"
import { StateStreamRefreshCoordinator } from "../../features/web/StateStreamRefreshCoordinator"
import { decodeStreamingRpcCommand } from "./StreamingRpcDecoder"
import { AgentSdkConfigBuilder } from "../configuration/AgentSdkConfigBuilder"
import { resolveEffectiveModelId } from "../models/EffectiveModelResolver"
import { PartialTextProjector } from "../conversation/PartialTextProjector"
import { FoldedProgressProjector } from "../conversation/FoldedProgressProjector"
import { ConversationRuntimeProjector } from "../conversation/ConversationRuntimeProjector"
import { ConversationCleanupCoordinator } from "../conversation/ConversationCleanupCoordinator"
import { ToolApprovalPromptProjector } from "../conversation/ToolApprovalPromptProjector"
import type { HookSettingsHandler } from "../../features/hooks/HookSettingsHandler"
import type { HookExecutionHandler } from "../../features/hooks/HookExecutionHandler"
import { HookLifecycleCoordinator } from "../../features/hooks/HookLifecycleCoordinator"
import {
	normalizeOllamaRootBaseUrl,
	inferModelInfo,
	inferContextWindow,
	inferMaxTokens,
	modelCapabilities,
	booleanField,
	modelInfoFromRemoteMetadata,
	parseModelPrice,
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
	firstString,
	shouldAutoApproveTool,
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
	agentChunkRecordToTerminalResult,
	agentChunkStringToTranscriptText,
	agentChunkStringToFoldedReasoningText,
	parseJsonObjectSequence,
	agentChunkRecordToTranscriptText,
	agentChunkRecordToFoldedReasoningText,
	isKnownAgentEventRecord,
	agentContentEventToText,
	unknownAgentChunkTextToTranscriptText,
	stripRawToolCallMarkup,
	buildResumedConversationMessages,
	clineMessageToResumedTranscriptEntry,
	resumedTranscriptTextForMessage,
	looksLikeTokenizedReasoning,
	looksLikeReasoningNarration,
	toolInputToText,
	toolResultToText,
	stringifyPretty,
	mapToolName,
	toolTranscriptToActivityEntries,
	formatToolActivitySection,
	normalizeTerminalOutputText,
	uniqueToolActivityEntries,
	splitToolPaths,
	looksLikeCommandText,
	uniqueStrings,
} from "../conversation/ConversationSupport"
import {
	type OAuthTokenExchangeConfig,
	resolveConfiguredContextWindow,
	positiveIntegerValue,
	resolveApiKey,
	providerCredentialFields,
	providerCredentialField,
	providerBaseUrlField,
	resolveBaseUrl,
	resolveProviderEnvApiKey,
	resolveProviderEnvBaseUrl,
	pickApiConfigurationFields,
	normalizeApiConfiguration,
	resolveOAuthCredentials,
	describeOAuthCredentialState,
	isAutoApprovalSettingsLike,
	createToolPolicies,
	isPlanModeBlockedTool,
	isWebFetchEnabled,
	webFetchDisabledReason,
} from "../configuration/ProviderConfiguration"
import { resolveModelId, selectProvider } from "../../features/providers/ProviderSelection"
import { createUnauthenticatedAccountState } from "../auth/ProviderAuthSupport"

export class VisualStudioWebviewBackend implements WebviewApplicationPort {
	private agentEngine: AgentEnginePort | null = null
	private taskSessions: TaskSessionUseCase | null = null
	private mcp: McpHandler | null = null
	private sendMessage: SendMessageHandler | null = null
	private startTaskHandler: StartTaskHandler | null = null
	private cancelTaskHandler: CancelTaskHandler | null = null
	private readonly clearTaskHandler: ClearTaskHandler
	private readonly cancelTaskFlow: CancelTaskFlow
	private readonly agentRunRecovery: AgentRunRecoveryFlow
	private readonly agentRunCompletion: AgentRunCompletionFlow
	private readonly sendOrResumeSession: SendOrResumeSessionFlow
	private readonly resumeSession: ResumeSessionFlow
	private readonly launchAgentSession: LaunchAgentSessionFlow
	private readonly prepareNewTask: PrepareNewTaskFlow
	private readonly startNewTaskFlow: StartNewTaskFlow
	private readonly askResponseInteractions: AskResponseInteractionFlow
	private readonly sendUserMessage: SendUserMessageFlow
	private readonly compactSession: CompactSessionFlow
	private browserHandler: BrowserHandler | null = null
	private worktreeQueries: WorktreeQueryHandler | null = null
	private worktreeMutations: WorktreeMutationHandler | null = null
	private readonly state: ReturnType<typeof createInitialState>
	private readonly approvals = new ApprovalCoordinator()
	private pendingQuestion:
		| {
				resolve: (value: AskQuestionResult) => void
		  }
		| null = null
	private readonly conversationProjection = new ConversationProjectionState()
	private readonly conversationMessages: ConversationMessageStore
	private readonly partialTextProjector: PartialTextProjector
	private readonly foldedProgressProjector: FoldedProgressProjector
	private readonly conversationRuntime: ConversationRuntimeProjector
	private readonly conversationCleanup: ConversationCleanupCoordinator
	private readonly toolApproval: ToolApprovalFlow
	private readonly toolApprovalPrompts = new ToolApprovalPromptProjector()
	private readonly taskSnapshots: TaskSnapshotStore
	private readonly taskState: TaskStateCoordinator
	private readonly taskHistorySync: TaskHistorySync
	private readonly taskHistoryCommands: TaskHistoryCommands
	private readonly taskTranscriptHydrator: TaskTranscriptHydrator
	private readonly agentTextEvents: AgentTextEventProjector
	private readonly agentToolEvents: AgentToolEventProjector
	private readonly agentLifecycleEvents: AgentLifecycleEventProjector
	private readonly agentAuxiliaryEvents: AgentAuxiliaryEventProjector
	private readonly agentSnapshotEvents: AgentSnapshotEventProjector
	private readonly agentChunkEvents: AgentChunkEventProjector
	private readonly taskCompletion: TaskCompletionProjector
	private readonly runtimeStatusEvents: RuntimeStatusEventProjector
	private readonly runtimeEvents: AgentRuntimeEventDispatcher
	private readonly semanticEvents: AgentEventDispatcher
	private readonly runtimeMonitoring: RuntimeMonitoringCoordinator
	private readonly taskSession: TaskSessionCoordinator
	private readonly apiConfigurationProfiles: ApiConfigurationProfileManager
	private readonly settingsMutations: SettingsMutationHandler
	private readonly settingsRpc: SettingsRpcHandler
	private readonly accountRpc: AccountRpcHandler
	private readonly browserRpc: BrowserRpcHandler
	private readonly terminalRpc: TerminalRpcHandler
	private readonly taskRpc: TaskRpcHandler
	private readonly checkpointRpc: CheckpointRpcHandler
	private readonly hookRpc: HookRpcHandler
	private readonly scheduledAgentRpc: ScheduledAgentRpcHandler
	private readonly worktreeRpc: WorktreeRpcHandler
	private readonly mcpRpc: McpRpcHandler
	private readonly modelCatalogRpc: ModelCatalogRpcHandler
	private readonly fileRpc: FileRpcHandler
	private readonly instructionSettingsRpc: InstructionSettingsRpcHandler
	private readonly uiWebRpc: UiWebRpcHandler
	private readonly pluginRpc: PluginRpcHandler
	private readonly streamingRpc: StreamingRpcHandler
	private readonly stateStreamRefresh: StateStreamRefreshCoordinator
	private readonly sdkConfigBuilder: AgentSdkConfigBuilder
	private readonly hookLifecycle: HookLifecycleCoordinator
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

	constructor(
		private readonly host: HostProviderPort,
		private readonly transport: WebviewTransportPort,
		private readonly logger: InteractionLoggerPort,
		private readonly stateStore: StatePersistenceUseCase,
		private readonly taskLifecycle: TaskLifecycleUseCase,
	) {
		this.state = loadInitialState(this.stateStore.load())
		this.taskSnapshots = new TaskSnapshotStore(this.state.taskSnapshots, (snapshots) => { this.state.taskSnapshots = snapshots })
		this.taskState = new TaskStateCoordinator({ snapshots: this.taskSnapshots, readCurrentTask: () => this.state.currentTaskItem, writeCurrentTask: (task) => { this.state.currentTaskItem = task }, readMessages: () => this.state.clineMessages, readHistory: () => this.state.taskHistory, writeHistory: (history) => { this.state.taskHistory = history }, schedulePersist: () => this.schedulePersistedStateSave() })
		this.runtimeMonitoring = new RuntimeMonitoringCoordinator({
			taskActivity: () => this.requireTaskActivity(),
			optionalTaskActivity: () => this.taskActivity,
			partialState: () => this.requirePartialStateScheduler(),
			optionalPartialState: () => this.partialStateScheduler,
			sendLatency: () => this.requireSendLatency(),
			hasCompletionResult: () => this.taskCompletion.hasCompletionAfterLastUser(),
		})
		this.taskSession = new TaskSessionCoordinator({
			lifecycle: this.taskLifecycle,
			logger: this.logger,
			activeSessionId: () => this.clineSdk?.status.activeSessionId || "",
			currentTask: () => this.state.currentTaskItem,
			writeCurrentTask: (task) => { this.state.currentTaskItem = task },
			isDeleted: (sessionId) => this.taskHistorySync.isDeleted(sessionId),
			rebindHistory: (previousTaskId, sessionId) => { this.state.taskHistory = rebindTaskHistoryId(this.state.taskHistory, previousTaskId, sessionId) },
			rebindSnapshot: (previousTaskId, sessionId) => {
				const snapshot = this.taskState.getSnapshot(previousTaskId)
				if (!snapshot) return
				this.taskState.forget(previousTaskId)
				this.taskState.remember(sessionId, snapshot.taskItem, snapshot.messages)
			},
			rebindLatency: (previousTaskId, sessionId) => this.runtimeMonitoring.rebindLatency(previousTaskId, sessionId),
			writeLifecycleStatus: (status) => { this.state.taskLifecycleStatus = status },
		})
		this.toolApproval = new ToolApprovalFlow({ mapToolName: (toolName) => mapToolName(toolName), isPlanModeBlocked: (mappedToolName) => this.state.mode === "plan" && isPlanModeBlockedTool(mappedToolName), blockedReason: () => this.toolApprovalPrompts.blockedReason(this.getUiLanguage()), addInfo: (text) => { this.addMessage({ type: "say", say: "info", text }) }, currentSessionId: () => this.getCurrentSessionId(), preToolUse: (context) => this.hookLifecycle.preToolUse(context), shouldAutoApprove: (toolName) => shouldAutoApproveTool(toolName, this.state.autoApprovalSettings), notifyAutoApproved: (mappedToolName, input) => this.notifyAutoApprovedTool(mappedToolName, input), buildPrompt: (mappedToolName, input, approvalRequest) => this.toolApprovalPrompts.build(mappedToolName, input, approvalRequest), beginApproval: () => { this.taskSession.transition("awaiting_user", "tool-approval"); this.taskSession.waitFor("tool_approval") }, addAsk: ({ ask, text }) => { this.addMessage({ type: "ask", ask, text }) }, updateTask: () => this.taskState.update(), broadcast: () => this.broadcastState(), requestApproval: () => this.approvals.request(), logRequest: (details) => this.logger.log("sdk->sidecar", "toolApproval.request", details), log: (event, details) => this.logger.log("sidecar", event, details) })
		this.conversationMessages = new ConversationMessageStore({ read: () => this.state.clineMessages, write: (messages) => { this.state.clineMessages = messages }, persist: () => this.schedulePersistedStateSave(), publishPartial: (message) => this.sendPartialMessage(message), log: (event, details) => this.logger.log("sidecar", event, details) })
		this.hookLifecycle = new HookLifecycleCoordinator({ execution: () => this.requireHookExecution(), workspaceRoot: () => this.getPrimaryWorkspaceRoot(), enabled: () => this.state.hooksEnabled !== false, addMessage: (message) => this.conversationMessages.add(message), nextTimestamp: () => this.conversationMessages.nextTimestamp(), upsertMessage: (timestamp, updates) => this.conversationMessages.upsert(timestamp, updates), updateTask: () => this.taskState.update(), broadcast: () => this.broadcastState().catch((error) => { console.error(error) }) })
		this.clearTaskHandler = new ClearTaskHandler(() => this.clineSdk, { transition: (status, source) => this.taskSession.transition(status, source), advanceRunGeneration: () => { this.sdkRunGeneration++ }, currentSessionId: () => this.clineSdk?.status.activeSessionId || String(this.state.currentTaskItem?.id || ""), markClosing: (sessionId) => { this.taskSession.markClosing(sessionId) }, rememberSnapshot: (sessionId) => { if (this.state.currentTaskItem && this.state.clineMessages.length > 0) { const taskId = String(this.state.currentTaskItem.id || sessionId); if (taskId) this.taskState.remember(taskId, this.state.currentTaskItem, this.state.clineMessages) } }, clearProjection: () => { this.conversationCleanup.clearProjection() }, clearInteractions: () => { this.approvals.clear({ approved: false, reason: "Task was closed." }); this.pendingQuestion?.resolve(""); this.pendingQuestion = null }, clearTaskState: () => { this.state.currentTaskItem = null; this.state.clineMessages = [] }, resetLifecycle: (source) => { this.taskSession.reset(source) }, persist: () => this.stateStore.save(createPersistedStateSnapshot(this.state)), broadcast: () => this.broadcastState(), log: (event, details) => this.logger.log("sidecar", event, details) })
		this.cancelTaskFlow = new CancelTaskFlow({ beginCancel: () => Boolean(this.taskSession.transition("cancelling", "cancel-request")), currentStatus: () => this.taskSession.status, advanceRunGeneration: () => { this.sdkRunGeneration++ }, hookSessionId: () => this.clineSdk?.status.activeSessionId || String(this.state.currentTaskItem?.id || ""), activeSessionId: () => this.clineSdk?.status.activeSessionId || "", cancelRemote: async (sessionId) => { if (this.cancelTaskHandler) await this.cancelTaskHandler.execute({ sessionId }) }, clearProjection: () => { this.conversationCleanup.clearProjection(); this.conversationCleanup.finalizeOpenPartials(); this.removeTerminalAskMessages() }, addInfo: (text) => { this.addMessage({ type: "say", say: "info", text }) }, updateTask: () => this.taskState.update(), runHook: (sessionId) => this.hookLifecycle.run("TaskCancel", { sessionId }), completeCancel: () => { this.taskSession.transition("idle", "cancel-complete") }, broadcast: () => this.broadcastState(), log: (event, details) => this.logger.log("sidecar", event, details) })
		this.agentRunRecovery = new AgentRunRecoveryFlow({ currentGeneration: () => this.sdkRunGeneration, activeText: () => this.partialTextProjector.activeText(), hasAssistantText: () => this.taskCompletion.hasAssistantAfterLastUser(), hydrate: (sessionId, source) => this.taskTranscriptHydrator.hydrateCurrent(sessionId, source, true), finishTask: (sessionId, status, text) => this.taskCompletion.finish(sessionId, status, text), updateTask: () => this.taskState.update(), broadcast: () => this.broadcastState(), projectFailure: (source, error) => { this.runtimeMonitoring.clearTaskActivity(); this.taskSession.transition("failed", `sdk-error:${source}`); this.runtimeMonitoring.clearPartialIdle(); this.clearReasoningStatus(); this.addMessage({ type: "say", say: "error", text: formatSdkErrorForUi(error, this.getUiLanguage()) }) }, log: (event, details) => this.logger.log("sidecar", event, details) })
		this.agentRunCompletion = new AgentRunCompletionFlow({ decode: (result, fallbackSessionId) => { const resultRecord = asRecord(result); const agentResult = asRecord(resultRecord.result ?? result); return { sessionId: getString(resultRecord, "sessionId") || fallbackSessionId || String(this.state.currentTaskItem?.id || ""), empty: Object.keys(agentResult).length === 0, text: extractCompletionTextFromResult(agentResult, resultRecord), finishReason: getString(agentResult, "finishReason") || getString(agentResult, "status") || "completed" } }, currentGeneration: () => this.sdkRunGeneration, currentTaskId: () => String(this.state.currentTaskItem?.id || ""), activeSessionId: () => this.clineSdk?.status.activeSessionId || "", bindSession: (sessionId) => this.taskSession.bindSession(sessionId), isCurrentSession: (sessionId) => this.taskSession.isCurrentResult(sessionId), hydrate: (sessionId, source) => this.taskTranscriptHydrator.hydrateCurrent(sessionId, source, true), activeText: () => this.partialTextProjector.activeText(), hasAssistantText: () => this.taskCompletion.hasAssistantAfterLastUser(), lastActivityReason: () => this.taskActivity?.reason || "", finishTask: (sessionId, status, text) => this.taskCompletion.finish(sessionId, status, text), failEmpty: (sessionId) => this.taskCompletion.fail(sessionId, formatEmptyModelResponseForUi(this.getUiLanguage())), finalizePartial: () => this.conversationCleanup.finalizeOpenPartials(), addCompletionMarker: (status) => this.taskCompletion.addMarker(status), updateTask: () => this.taskState.update(), broadcast: () => this.broadcastState(), log: (event, details) => this.logger.log("sidecar", event, details) })
		this.sendOrResumeSession = new SendOrResumeSessionFlow(() => this.clineSdk, { activeSettingsRevision: () => this.activeSessionRuntimeSettingsRevision, settingsRevision: () => this.runtimeSettingsRevision, markClosing: (sessionId, closing) => { if (closing) this.taskSession.markClosing(sessionId); else this.taskSession.prepareActivation(sessionId) }, send: (command) => { if (!this.sendMessage) return Promise.reject(new Error("SendMessageHandler is not attached.")); return this.sendMessage.execute(command) }, resume: (sessionId, command, textLength) => this.resumeSession.execute(sessionId, command, textLength), markSend: (sessionId) => this.runtimeMonitoring.markSdkSend(sessionId), markError: (sessionId, error) => this.runtimeMonitoring.markError(sessionId, error), isSessionNotFound: (error) => isSessionNotFoundError(error), log: (event, details) => this.logger.log("sidecar", event, details) })
		this.resumeSession = new ResumeSessionFlow({ isRuntimeAvailable: () => Boolean(this.clineSdk), workspaceRoots: () => this.host.workspaceClient.getWorkspacePaths({}), currentCwd: () => String(this.state.currentTaskItem?.cwdOnTaskInitialization || ""), prepareTask: (sessionId, prompt, cwd) => { const taskItem = this.state.currentTaskItem || createHistoryItem(sessionId, prompt, cwd, this.getModelId()); this.state.currentTaskItem = { ...taskItem, id: sessionId, cwdOnTaskInitialization: cwd, modelId: String(taskItem.modelId || "") || this.getModelId() }; this.state.taskHistory = upsertTaskHistoryItem(this.state.taskHistory, this.state.currentTaskItem); return { title: String(taskItem.task || "").trim() } }, noteActivity: (reason) => this.runtimeMonitoring.noteActivity(reason), updateTask: () => this.taskState.update(), broadcast: () => this.broadcastState(), runResumeHook: (context) => { void this.hookLifecycle.run("TaskResume", context) }, buildInitialMessages: (prompt) => buildResumedConversationMessages(this.state.clineMessages, prompt, this.getResumedConversationCharBudget()), normalizeImages: (images) => normalizeSdkImageInputs([...images]), buildConfig: (cwd, sessionId) => this.sdkConfigBuilder.build(cwd, sessionId), toolPolicies: () => this.createCurrentToolPolicies(), start: (command) => { if (!this.startTaskHandler) return Promise.reject(new Error("StartTaskHandler is not attached.")); return this.startTaskHandler.execute(command) }, markSettingsRevisionActive: () => { this.activeSessionRuntimeSettingsRevision = this.runtimeSettingsRevision }, log: (event, details) => this.logger.log("sidecar", event, details) })
		this.launchAgentSession = new LaunchAgentSessionFlow({ isRuntimeAvailable: () => Boolean(this.clineSdk), buildConfig: (cwd, sessionId) => this.sdkConfigBuilder.build(cwd, sessionId), toolPolicies: () => this.createCurrentToolPolicies(), markSend: (sessionId) => this.runtimeMonitoring.markSdkSend(sessionId), nextGeneration: () => ++this.sdkRunGeneration, currentGeneration: () => this.sdkRunGeneration, start: (command) => { if (!this.startTaskHandler) return Promise.reject(new Error("StartTaskHandler is not attached.")); return this.startTaskHandler.execute(command) }, markSettingsRevisionActive: () => { this.activeSessionRuntimeSettingsRevision = this.runtimeSettingsRevision }, complete: (result, sessionId, source, generation) => this.agentRunCompletion.complete(result, sessionId, source, generation), recover: (sessionId, source, generation, error) => this.agentRunRecovery.recover(sessionId, source, generation, error), log: (event, details) => this.logger.log("sidecar", event, details) })
		this.prepareNewTask = new PrepareNewTaskFlow({ isRuntimeAvailable: () => Boolean(this.clineSdk), workspaceRoots: () => this.host.workspaceClient.getWorkspacePaths({}), resolveWorkspacePath: (requestedPath) => requestedPath && fs.existsSync(requestedPath) ? path.resolve(requestedPath) : null, updateTask: () => this.taskState.update(), publishPreparing: () => this.sendPartialMessage(this.state.clineMessages.find((message) => message.ts === this.conversationProjection.activeReasoningTextTs)), activeSessionId: () => this.requireClineSdk().status.activeSessionId || "", markClosing: (sessionId) => { this.taskSession.markClosing(sessionId) }, stopSession: (sessionId) => this.requireClineSdk().stop({ sessionId }), runHook: (name, context) => { void this.hookLifecycle.run(name, context) }, normalizeImages: (images) => normalizeSdkImageInputs(images), launch: (params, cwd, sessionId) => this.launchAgentSession.execute(params, cwd, sessionId, "startSession"), projectError: async (error) => { this.runtimeMonitoring.clearTaskActivity(); this.addMessage({ type: "say", say: "error", text: error instanceof Error ? error.message : String(error) }); this.taskState.update(); await this.broadcastState() }, log: (event, details) => this.logger.log("sidecar", event, details) })
		this.startNewTaskFlow = new StartNewTaskFlow({ isRuntimeAvailable: () => Boolean(this.clineSdk), transitionStarting: () => { this.taskSession.transition("starting", "start-new-task") }, createTask: (input) => createHistoryItem(createId(), input.text, input.initialCwd, this.getModelId()), startLatency: (requestId, taskId, textLength) => this.runtimeMonitoring.startLatency(requestId, "newTask", taskId, textLength), beginConversation: () => { this.state.clineMessages = []; this.conversationProjection.beginTask() }, selectTask: (task) => { this.state.currentTaskItem = task; this.state.taskHistory = upsertTaskHistoryItem(this.state.taskHistory, task) }, addUserTask: (text, images, files) => { this.addMessage({ type: "say", say: "task", text, images, files }) }, showPreparing: () => this.foldedProgressProjector.upsertReasoning(this.state.uiLanguage === "en" ? "Preparing response." : "응답을 준비하는 중입니다."), noteActivity: (reason) => this.runtimeMonitoring.noteActivity(reason), updateTask: () => this.taskState.update(), persist: () => this.schedulePersistedStateSave(), broadcast: () => { this.broadcastState().catch((error) => console.error(error)) }, prepare: (input, task) => { void this.prepareNewTask.execute({ text: input.text, images: input.images, files: input.files, requestedWorkspacePath: input.requestedWorkspacePath, initialCwd: input.initialCwd, taskItem: task }) } })
		this.askResponseInteractions = new AskResponseInteractionFlow({ hasPendingApproval: () => this.approvals.hasPending, hasPendingQuestion: () => Boolean(this.pendingQuestion), takeApproval: () => this.approvals.take(), takeQuestion: () => { const pending = this.pendingQuestion; this.pendingQuestion = null; return pending?.resolve }, transitionStreaming: (source) => { this.taskSession.transition("streaming", source) }, removeFollowup: () => this.removeAskMessages("followup"), addFeedback: (text, images, files) => { this.addMessage({ type: "say", say: "user_feedback", text, images, files }) }, updateTask: () => this.taskState.update(), broadcast: () => this.broadcastState(), log: (event, details) => this.logger.log("sidecar", event, details) })
		this.sendUserMessage = new SendUserMessageFlow({ hasPendingApproval: () => this.approvals.hasPending, hasPendingQuestion: () => Boolean(this.pendingQuestion), clearPending: () => { this.approvals.clear({ approved: false, reason: "Superseded by resumed chat message." }); this.pendingQuestion?.resolve(""); this.pendingQuestion = null }, startNewTask: (input) => this.startNewTask({ text: input.prompt, images: input.images, files: input.files }, { broadcast: true, requestId: input.requestId }), startLatency: (requestId, sessionId, textLength) => this.runtimeMonitoring.startLatency(requestId, "askResponse", sessionId, textLength), transitionStarting: () => { this.taskSession.transition("starting", "send-response") }, projectUserMessage: (text) => { this.removeTerminalAskMessages(); const message = this.addMessage({ type: "say", say: "user_feedback", text }); this.foldedProgressProjector.beginReasoning(); return message }, showPreparing: () => this.foldedProgressProjector.upsertReasoning(this.state.uiLanguage === "en" ? "Preparing response." : "응답을 준비하는 중입니다."), persist: () => this.schedulePersistedStateSave(), publishPartial: (message) => this.sendPartialMessage(message !== null && typeof message === "object" && !Array.isArray(message) ? message as Record<string, unknown> : undefined), broadcast: () => { this.broadcastState().catch((error) => console.error(error)) }, normalizeImages: (images) => normalizeSdkImageInputs(images), runHook: (context) => { void this.hookLifecycle.run("UserPromptSubmit", context) }, nextGeneration: () => ++this.sdkRunGeneration, currentGeneration: () => this.sdkRunGeneration, send: (sessionId, command, textLength) => this.sendOrResumeSession.execute(sessionId, command, textLength), resultSessionId: (result, fallback) => getString(asRecord(result), "sessionId") || fallback, complete: (result, sessionId, generation) => this.agentRunCompletion.complete(result, sessionId, "send", generation), recover: (sessionId, generation, error) => this.agentRunRecovery.recover(sessionId, "send", generation, error), log: (event, details) => this.logger.log("sidecar", event, details) })
		this.compactSession = new CompactSessionFlow({ isRuntimeAvailable: () => Boolean(this.clineSdk), activeSessionId: () => this.clineSdk?.status.activeSessionId || "", selectedSessionId: () => String(this.state.currentTaskItem?.id || ""), language: () => this.state.uiLanguage === "en" ? "en" : "ko", mode: () => this.state.mode === "plan" ? "plan" : "act", addError: (text) => { this.addMessage({ type: "say", say: "error", text }) }, startLatency: (requestId, sessionId, textLength) => this.runtimeMonitoring.startLatency(requestId, "askResponse", sessionId, textLength), showProgress: (text) => { this.foldedProgressProjector.beginReasoning(); this.foldedProgressProjector.upsertReasoning(text) }, persist: () => this.schedulePersistedStateSave(), broadcast: () => this.broadcastState(), nextGeneration: () => ++this.sdkRunGeneration, currentGeneration: () => this.sdkRunGeneration, send: (sessionId, command, textLength) => this.sendOrResumeSession.execute(sessionId, command, textLength), resultSessionId: (result, fallback) => getString(asRecord(result), "sessionId") || fallback, complete: (result, sessionId, generation) => this.agentRunCompletion.complete(result, sessionId, "compact", generation), recover: (sessionId, generation, error) => this.agentRunRecovery.recover(sessionId, "compact", generation, error), log: (event, details) => this.logger.log("sidecar", event, details) })
		this.apiConfigurationProfiles = new ApiConfigurationProfileManager({ readConfiguration: () => asRecord(this.state.apiConfiguration), writeConfiguration: (configuration) => { this.state.apiConfiguration = configuration as typeof this.state.apiConfiguration }, readProfiles: () => this.state.apiConfigurationProfiles, writeProfiles: (profiles) => { this.state.apiConfigurationProfiles = profiles }, readActiveId: () => this.state.activeApiConfigurationProfileId, writeActiveId: (profileId) => { this.state.activeApiConfigurationProfileId = profileId }, readSeparateModels: () => this.state.planActSeparateModelsSetting, writeSeparateModels: (enabled) => { this.state.planActSeparateModelsSetting = enabled } })
		this.settingsMutations = new SettingsMutationHandler({ state: () => this.state as unknown as Record<string, unknown>, profiles: this.apiConfigurationProfiles, refreshWebTools: () => this.refreshWebToolFeatureState(), runtimeChanged: () => { this.runtimeSettingsRevision++; this.logger.log("sidecar", "runtimeSettingsChanged", { runtimeSettingsRevision: this.runtimeSettingsRevision, activeSessionRuntimeSettingsRevision: this.activeSessionRuntimeSettingsRevision }) } })
		this.settingsRpc = new SettingsRpcHandler({ state: () => this.state as unknown as Record<string, unknown>, applySettings: (settings) => this.settingsMutations.apply(settings), persist: () => this.stateStore.save(createPersistedStateSnapshot(this.state)), broadcast: () => this.broadcastState(), clearPersistedState: () => this.stateStore.clear(), resetState: () => { Object.assign(this.state, createInitialState()) }, clearTask: () => this.clearTaskHandler.execute() })
		this.accountRpc = new AccountRpcHandler({ authorization: () => this.requireOAuthAuthorization(), callback: () => this.requireOAuthCallbackHandler(), authActions: () => this.requireProviderAuthActions(), credentials: () => this.requireProviderCredentials(), configuration: () => asRecord(this.state.apiConfiguration), mutateConfiguration: (updates, deletes) => { const next = { ...asRecord(this.state.apiConfiguration), ...updates }; for (const field of deletes) delete next[field]; this.state.apiConfiguration = normalizeApiConfiguration(next) as typeof this.state.apiConfiguration }, syncProfiles: () => this.apiConfigurationProfiles.syncActive(), setCodexAuthenticated: (authenticated) => { this.state.openAiCodexIsAuthenticated = authenticated }, persist: () => this.stateStore.save(createPersistedStateSnapshot(this.state)), broadcast: () => this.broadcastState(), log: (event, details) => this.logger.log("sidecar", event, details) })
		this.browserRpc = new BrowserRpcHandler({ browser: () => this.requireBrowserHandler(), settings: () => this.getBrowserSettings() })
		this.terminalRpc = new TerminalRpcHandler(this.host.workspaceClient)
		this.sdkConfigBuilder = new AgentSdkConfigBuilder({ state: () => this.state as unknown as Record<string, unknown>, resolveModelId: (configuration, providerId, modePrefix, baseUrl) => resolveEffectiveModelId(configuration, providerId, modePrefix, baseUrl, (modelId) => this.applyDefaultOllamaModel(modelId)), scheduledAgentsEnabled: () => this.isScheduledAgentsEnabled(), log: (event, details) => this.logger.log("sidecar", event, details) })
		this.taskHistorySync = new TaskHistorySync({ isAvailable: () => Boolean(this.clineSdk), listHistory: () => this.clineSdk?.listHistory({ limit: 200 }) ?? Promise.resolve(null), projectSession: (session) => sdkSessionToHistoryItem(asRecord(session)), readHistory: () => this.state.taskHistory, writeHistory: (history) => { this.state.taskHistory = history }, broadcast: () => this.broadcastState(), log: (event, details) => this.logger.log("sidecar", event, details) })
		this.taskHistoryCommands = new TaskHistoryCommands({ readHistory: () => this.state.taskHistory, writeHistory: (history) => { this.state.taskHistory = history }, readCurrentTask: () => this.state.currentTaskItem, writeCurrentTask: (task) => { this.state.currentTaskItem = task }, clearMessages: () => { this.state.clineMessages = [] }, clearLiveInteraction: (reason) => this.conversationCleanup.clearLiveInteraction(reason), markDeleted: (taskId) => this.taskHistorySync.markDeleted(taskId), removeDeleted: (history) => this.taskHistorySync.removeDeleted(history), listRemoteTaskIds: async () => { if (!this.clineSdk) return []; const sessions = await this.clineSdk.listHistory({ limit: 1000 }); return Array.isArray(sessions) ? sessions.map((session) => getString(asRecord(session), "id") || getString(asRecord(session), "sessionId")).filter(Boolean) : [] }, deleteRemote: (taskId) => this.clineSdk?.deleteSession({ sessionId: taskId }) ?? Promise.resolve(undefined), updateRemoteFavorite: (taskId, isFavorited) => this.clineSdk?.updateSession({ sessionId: taskId, metadata: { isFavorited } }) ?? Promise.resolve(undefined), getSnapshot: (taskId) => this.taskState.getSnapshot(taskId), rememberSnapshot: (taskId, task, messages) => this.taskState.remember(taskId, task, messages), forgetSnapshot: (taskId) => this.taskState.forget(taskId), clearSnapshots: () => this.taskState.clearSnapshots(), persist: () => this.stateStore.save(createPersistedStateSnapshot(this.state)), log: (event, details) => this.logger.log("sidecar", event, details) })
		this.taskRpc = new TaskRpcHandler({ hasPendingQuestion: () => Boolean(this.pendingQuestion), hasCurrentTask: () => Boolean(this.state.currentTaskItem), start: (request, requestId) => this.startNewTask(request, { broadcast: true, requestId }), respond: (request, requestId) => this.sendAskResponse(request, requestId), compact: (requestId) => this.compactSession.execute(requestId), cancel: () => this.cancelTaskFlow.execute(), clear: () => this.clearTaskHandler.execute(), refreshHistory: (source) => this.taskHistorySync.refreshInBackground(source), history: () => this.state.taskHistory, show: (taskId) => this.taskTranscriptHydrator.show(taskId), delete: (taskIds) => this.taskHistoryCommands.delete(taskIds), deleteAll: () => this.taskHistoryCommands.deleteAll(), toggleFavorite: (taskId, isFavorited) => this.taskHistoryCommands.toggleFavorite(taskId, isFavorited), broadcast: () => this.broadcastState() })
		this.checkpointRpc = new CheckpointRpcHandler({ available: () => Boolean(this.clineSdk), checkpoints: () => this.requireCheckpoints(), currentTask: () => this.state.currentTaskItem, messages: () => this.state.clineMessages, workspaceRoot: () => this.getPrimaryWorkspaceRoot(), buildConfig: (cwd, sessionId) => this.sdkConfigBuilder.build(cwd, sessionId), toolPolicies: () => this.createCurrentToolPolicies(), showTask: (taskId) => this.taskTranscriptHydrator.show(taskId), addInfo: (text, checkpointRunCount) => { this.addMessage({ type: "say", say: "info", text, checkpointRunCount }) }, updateTask: () => this.taskState.update(), broadcast: () => this.broadcastState(), trackedChanges: () => this.requireChangeTracking().pendingChanges() })
		this.hookRpc = new HookRpcHandler({ hooks: () => this.requireHookSettings(), workspaceRoot: () => this.getPrimaryWorkspaceRoot(), enableHooks: () => { this.state.hooksEnabled = true } })
		this.scheduledAgentRpc = new ScheduledAgentRpcHandler({ agents: () => this.requireScheduledAgents(), workspaceRoot: () => this.getPrimaryWorkspaceRoot(), launch: async (request) => { await this.startNewTask(request, { broadcast: false }) } })
		this.worktreeRpc = new WorktreeRpcHandler({ queries: () => this.requireWorktreeQueries(), mutations: () => this.requireWorktreeMutations(), workspaceRoot: () => this.getPrimaryWorkspaceRoot(), setFeatureEnabled: (enabled) => this.setWorktreesFeatureFlag(enabled) })
		this.mcpRpc = new McpRpcHandler({ mcp: () => this.requireMcp(), openSettings: (filePath) => this.host.windowClient.openFile({ filePath }), markRuntimeChanged: () => { this.runtimeSettingsRevision++ } })
		this.modelCatalogRpc = new ModelCatalogRpcHandler({ ollamaValues: (baseUrl) => this.requireProviderModelCatalogs().ollamaValues(baseUrl), refresh: (providerId, request) => this.requireProviderModelCatalogs().refresh(providerId, request, asRecord(this.state.apiConfiguration), this.state.mode, this.getModelId()), askSage: (baseUrl) => this.requireProviderModelCatalogs().askSageModels(baseUrl), openRouterKeyInfo: (apiKey) => this.requireProviderModelCatalogs().openRouterKeyInfo(apiKey), unsupported: (key) => this.requireProviderModelCatalogs().unsupported(key) })
		this.fileRpc = new FileRpcHandler({ host: this.host, workspaceRoot: () => this.getPrimaryWorkspaceRoot(), resolvePath: (workspaceRoot, filePath) => path.isAbsolute(filePath) ? filePath : workspaceRoot ? path.resolve(workspaceRoot, filePath) : filePath, baseName: (filePath) => path.basename(filePath), exists: (filePath) => fs.existsSync(filePath), revert: (request) => this.requireChangeTracking().revert(request) })
		this.instructionSettingsRpc = new InstructionSettingsRpcHandler({ sdkSettings: () => this.requireSdkSettings(), workspaceRoot: () => this.getPrimaryWorkspaceRoot(), writeInstructions: ({ globalRules, localRules, globalWorkflows, localWorkflows }) => { this.state.globalClineRulesToggles = globalRules; this.state.localClineRulesToggles = localRules; this.state.globalWorkflowToggles = globalWorkflows; this.state.localWorkflowToggles = localWorkflows }, legacyRuleToggles: () => ({ cursor: this.state.localCursorRulesToggles, windsurf: this.state.localWindsurfRulesToggles, agents: this.state.localAgentsRulesToggles }), writeSkills: ({ global, local }) => { this.state.globalSkillsToggles = global; this.state.localSkillsToggles = local }, addError: (text) => { this.addMessage({ type: "say", say: "error", text }) } })
		this.uiWebRpc = new UiWebRpcHandler({ openExternal: (url) => this.host.envClient.openExternal({ value: url }), checkImage: (url) => checkIsImageUrl(url), openGraph: (url) => fetchOpenGraphData(url) })
		this.pluginRpc = new PluginRpcHandler({ workspaceRoot: () => this.getPrimaryWorkspaceRoot(), discover: (workspaceRoot) => discoverLocalPlugins(workspaceRoot) })
		this.stateStreamRefresh = new StateStreamRefreshCoordinator({ logger: this.logger, delayMs: () => readPositiveIntEnv("VSCLINE_STATE_REFRESH_DELAY_MS", 2500), shouldSkipScheduledRefresh: () => Boolean(this.state.currentTaskItem && this.clineSdk?.status.activeSessionId), refreshHistory: () => this.taskHistorySync.refresh(), refreshSelectedTask: () => this.taskTranscriptHydrator.refreshSelected(), broadcast: () => this.broadcastState(), formatError: (error) => stringify(error) })
		this.streamingRpc = new StreamingRpcHandler({ scheduleStateRefresh: () => this.stateStreamRefresh.schedule(), subscribeState: (requestId) => this.requireStreamPublisher().subscribeState(requestId), subscribePartial: (requestId) => { this.requireStreamPublisher().subscribePartial(requestId) }, unauthenticatedAccount: () => createUnauthenticatedAccountState(), mcpServers: async () => (await this.mcpRpc.handle({ type: "list" })).payload, mcpMarketplace: async () => (await this.mcpRpc.handle({ type: "marketplace" })).payload })
		this.taskTranscriptHydrator = new TaskTranscriptHydrator({
			isAvailable: () => Boolean(this.clineSdk && this.taskSessions),
			readCurrentTask: () => this.state.currentTaskItem,
			activeSessionId: () => this.clineSdk?.status.activeSessionId || "",
			hasLiveProjection: () => Boolean(this.conversationProjection.activePartialTextTs || this.conversationProjection.activeReasoningTextTs || this.conversationProjection.activeToolActivityTs),
			readMessages: () => this.state.clineMessages,
			loadTranscript: (taskId) => this.taskSessions?.load(taskId) ?? Promise.resolve(null),
			activateTranscript: (taskId) => this.taskSessions!.activateAndRead(taskId),
			getSnapshot: (taskId) => this.taskState.getSnapshot(taskId),
			prepareActivation: (taskId) => { this.taskSession.prepareActivation(taskId) },
			clearLiveInteraction: (reason) => this.conversationCleanup.clearLiveInteraction(reason),
			projectSession: (session) => sdkSessionToHistoryItem(asRecord(session)),
			projectMessages: (messages, task) => sdkMessagesToClineMessages(messages, task),
			applySelected: (taskId, task, messages) => { this.state.currentTaskItem = task; this.state.clineMessages = messages; this.taskState.remember(taskId, task, messages); this.schedulePersistedStateSave() },
			applyShown: (taskId, task, messages) => { this.state.currentTaskItem = task; this.state.clineMessages = messages; this.taskState.remember(taskId, task, messages); this.stateStore.save(createPersistedStateSnapshot(this.state)) },
			applyCompleted: (taskId, task, messages) => { this.runtimeMonitoring.clearTaskActivity(); this.runtimeMonitoring.clearPartialIdle(); this.clearReasoningStatus(); this.conversationProjection.activePartialTextTs = null; this.conversationProjection.activeReasoningTextTs = null; this.conversationProjection.activeToolActivityTs = null; this.conversationProjection.activeAssistantTextBuffer = ""; this.state.currentTaskItem = task; this.state.clineMessages = messages; this.conversationCleanup.finalizeOpenPartials(); this.taskCompletion.addMarker("completed"); this.taskState.update(); this.taskState.remember(taskId, task, this.state.clineMessages); this.schedulePersistedStateSave() },
			summarizeMessage: (message) => summarizeClineMessageForLog(message),
			log: (event, details) => this.logger.log("sidecar", event, details),
			broadcast: () => this.broadcastState(),
			isSessionNotFound: (error) => isSessionNotFoundError(error),
		})
		this.partialTextProjector = new PartialTextProjector(this.conversationProjection, () => this.state.clineMessages, () => this.conversationMessages.nextTimestamp(), (timestamp, updates) => this.conversationMessages.upsert(timestamp, updates), (message) => this.sendPartialMessage(message), () => this.runtimeMonitoring.schedulePartialIdle(), () => this.runtimeMonitoring.clearPartialIdle(), () => this.runtimeMonitoring.clearPartialBroadcast(), () => this.runtimeMonitoring.broadcastPartialNow(), () => this.runtimeMonitoring.schedulePartialBroadcast())
		this.foldedProgressProjector = new FoldedProgressProjector(this.conversationProjection, () => this.state.clineMessages, () => this.conversationMessages.nextTimestamp(), (timestamp, updates) => this.conversationMessages.upsert(timestamp, updates), (message) => this.sendPartialMessage(message), () => this.runtimeMonitoring.broadcastPartialNow(), () => this.runtimeMonitoring.schedulePartialBroadcast(), () => this.terminalActivity?.stop(), () => this.getUiLanguage())
		this.conversationRuntime = new ConversationRuntimeProjector({ projection: this.conversationProjection, messages: () => this.state.clineMessages, messageStore: this.conversationMessages, partial: this.partialTextProjector, folded: this.foldedProgressProjector, language: () => this.getUiLanguage(), currentSessionId: () => this.getCurrentSessionId(), markFirstAssistant: (sessionId, textLength) => this.runtimeMonitoring.markFirstAssistant(sessionId, textLength), schedulePartialIdle: () => this.runtimeMonitoring.schedulePartialIdle(), schedulePartialBroadcast: () => this.runtimeMonitoring.schedulePartialBroadcast(), addMessage: (message) => { this.addMessage(message) }, publishPartial: (message) => this.sendPartialMessage(message) })
		this.conversationCleanup = new ConversationCleanupCoordinator({ projection: this.conversationProjection, messages: this.conversationMessages, partial: this.partialTextProjector, folded: this.foldedProgressProjector, runtime: this.conversationRuntime, monitoring: this.runtimeMonitoring, terminalActive: () => this.terminalActivity?.isActive === true, stopTerminal: () => { this.terminalActivity?.stop() }, hasPendingApproval: () => this.approvals.hasPending, hasPendingQuestion: () => Boolean(this.pendingQuestion), clearApproval: (reason) => { this.approvals.clear({ approved: false, reason }) }, clearQuestion: () => { this.pendingQuestion?.resolve(""); this.pendingQuestion = null }, logger: this.logger })
		this.taskCompletion = new TaskCompletionProjector({ messages: () => this.state.clineMessages, transition: (status, source) => { this.taskSession.transition(status, source) }, clearFinishStatus: () => { this.runtimeMonitoring.clearTaskActivity(); this.runtimeMonitoring.clearPartialIdle(); this.clearReasoningStatus() }, finishProgress: () => { this.conversationCleanup.finishProgress() }, prepareAssistant: () => { this.conversationCleanup.prepareAssistant() }, activeText: () => this.partialTextProjector.activeText(), addMessage: (message) => { this.addMessage(message) }, markAssistantLatency: (length) => this.runtimeMonitoring.markFirstAssistant(this.getCurrentSessionId(), length), finalizeOpenPartial: () => this.conversationCleanup.finalizeOpenPartials(), lastActivityReason: () => this.taskActivity?.reason || "", runCompleteHook: (context) => { void this.hookLifecycle.run("TaskComplete", context) }, persist: () => this.stateStore.save(createPersistedStateSnapshot(this.state)), language: () => this.getUiLanguage(), recentToolSummaries: () => this.conversationProjection.recentToolSummaries(5), log: (event, details) => this.logger.log("sidecar", event, details) })
		this.runtimeStatusEvents = new RuntimeStatusEventProjector({ shouldIgnore: (sessionId) => this.taskSession.shouldIgnoreEvent(sessionId), markFirstEvent: (sessionId, eventType) => this.runtimeMonitoring.markFirstSdkEvent(sessionId, eventType), activeText: () => this.partialTextProjector.activeText(), finishTask: (sessionId, status, text) => this.taskCompletion.finish(sessionId, status, text), updateTask: () => this.taskState.update(), broadcast: () => { this.broadcastState().catch((error) => console.error(error)) }, transitionStreaming: (source) => { this.taskSession.transition("streaming", source) }, noteActivity: (reason) => this.runtimeMonitoring.noteActivity(reason), schedulePartial: () => this.runtimeMonitoring.schedulePartialBroadcast(), log: (event, details) => this.logger.log("sidecar", event, details) })
		this.runtimeEvents = new AgentRuntimeEventDispatcher({ transitionStreaming: (source) => { this.taskSession.transition("streaming", source) }, shouldIgnore: (sessionId) => this.taskSession.shouldIgnoreEvent(sessionId), markFirstEvent: (sessionId, eventType) => this.runtimeMonitoring.markFirstSdkEvent(sessionId, eventType), projectAgent: (event, sessionId) => this.semanticEvents.handle(event, sessionId), trackWorkspaceChange: (change) => { this.handleFileChangedEvent(change).catch((error) => console.error(error)) }, projectChunk: (event) => this.agentChunkEvents.handle(event), projectSnapshot: (event) => this.agentSnapshotEvents.handle(event), projectAuxiliary: (event) => this.agentAuxiliaryEvents.handle(event), projectLifecycle: (event) => this.runtimeStatusEvents.handle(event), log: (event, details) => this.logger.log("sidecar", event, details), activeSessionId: () => this.clineSdk?.status.activeSessionId || "", currentTaskId: () => String(this.state.currentTaskItem?.id || "") })
		this.agentTextEvents = new AgentTextEventProjector({ noteActivity: (reason) => this.runtimeMonitoring.noteActivity(reason), clearReasoning: () => this.clearReasoningStatus(), recordReasoning: (text) => this.handleReasoningDelta(text), foldReasoning: (text) => this.foldedProgressProjector.upsertReasoning(text), upsertAssistant: (accumulated, delta) => this.conversationRuntime.upsertAssistant(accumulated, delta), completeAssistant: (text) => this.conversationRuntime.completeAssistant(text), activeAssistantText: () => this.conversationProjection.activeAssistantTextBuffer })
		this.agentToolEvents = new AgentToolEventProjector({ noteActivity: (reason) => this.runtimeMonitoring.noteActivity(reason), clearReasoning: () => this.clearReasoningStatus(), clearPartial: () => { this.runtimeMonitoring.clearPartialIdle(); this.conversationProjection.activePartialTextTs = null }, recordActivity: (tool, text) => this.conversationRuntime.recordToolActivity(tool, text), startTerminal: () => this.requireTerminalActivity().start(), stopTerminal: () => this.terminalActivity?.stop(), finalPollTerminal: () => { this.requireTerminalActivity().poll().catch((error) => this.logger.log("sidecar", "terminalStateFinalPollFailed", { message: stringify(error) })) }, postToolUse: (event) => { void this.hookLifecycle.run("PostToolUse", { sessionId: event.sessionId, toolName: event.toolName, input: event.input, output: event.output, error: event.error, iteration: event.iteration }) }, handleBrowser: (tool, input, error) => { void this.handleBrowserToolEvent(tool, input, error) }, shouldSuppressTrackedEdit: (tool, path) => (tool === "editor" || tool === "edit") && (this.hasRecentlyTrackedChange() || Boolean(path && this.wasRecentlyTracked(path))), rememberSummary: (tool, text) => this.rememberToolSummary(tool, text), appendTerminal: (text) => this.foldedProgressProjector.appendTerminal(text), moveProgressToEnd: () => this.foldedProgressProjector.moveActiveToEnd(), language: () => this.getUiLanguage() })
		this.agentLifecycleEvents = new AgentLifecycleEventProjector({ noteActivity: (reason) => this.runtimeMonitoring.noteActivity(reason), clearReasoning: () => this.clearReasoningStatus(), finishToolActivity: () => this.conversationRuntime.finishToolActivity(), finishProgress: () => this.foldedProgressProjector.finish(), finalizePartial: () => this.partialTextProjector.finalize(), addText: (text) => this.addMessage({ type: "say", say: "text", text }), addError: (text) => this.addMessage({ type: "say", say: "error", text }), finishTask: (sessionId, status, text) => this.taskCompletion.finish(sessionId, status, text), updateUsage: (usage) => this.taskState.update(usage), hasCompletion: () => this.taskCompletion.hasCompletionAfterLastUser(), activePartialText: () => this.partialTextProjector.activeText(), hasAssistantAfterUser: () => this.taskCompletion.hasAssistantAfterLastUser(), log: (event, details) => this.logger.log("sidecar", event, details), formatError: (error) => formatProviderErrorForTranscript(error, this.getUiLanguage()), markErrorLatency: (sessionId, error) => this.runtimeMonitoring.markError(sessionId, error) })
		this.semanticEvents = new AgentEventDispatcher({ bindSession: (sessionId) => this.taskSession.bindSession(sessionId), projectText: (event) => this.agentTextEvents.handle(event), projectTool: (event) => this.agentToolEvents.handle(event), projectLifecycle: (event) => this.agentLifecycleEvents.handle(event), updateTask: () => this.taskState.update(), broadcast: () => { this.broadcastState().catch((error) => console.error(error)) } })
		this.agentAuxiliaryEvents = new AgentAuxiliaryEventProjector({ noteActivity: (reason) => this.runtimeMonitoring.noteActivity(reason), addMessage: (message) => { this.addMessage(message) }, updateTask: () => this.taskState.update(), broadcast: () => { this.broadcastState().catch((error) => console.error(error)) }, log: (event, details) => this.logger.log("sidecar", event, details) })
		this.agentSnapshotEvents = new AgentSnapshotEventProjector({ bindSession: (sessionId) => this.taskSession.bindSession(sessionId), finishTask: (sessionId, status, text) => this.taskCompletion.finish(sessionId, status, text), noteActivity: (reason) => this.runtimeMonitoring.noteActivity(reason), activeText: () => this.partialTextProjector.activeText(), updateTask: (updates) => this.taskState.update(updates), broadcast: () => { this.broadcastState().catch((error) => console.error(error)) } })
		this.agentChunkEvents = new AgentChunkEventProjector({ noteActivity: (reason) => this.runtimeMonitoring.noteActivity(reason), noteQuietActivity: (reason) => this.runtimeMonitoring.noteQuietActivity(reason), finishTask: (status, text) => this.taskCompletion.finish(this.clineSdk?.status.activeSessionId || String(this.state.currentTaskItem?.id || ""), status, text), addMessage: (message) => { this.addMessage(message) }, recordTool: (text) => this.conversationRuntime.recordToolActivity("tool", text), foldReasoning: (text) => this.foldedProgressProjector.upsertReasoning(text), updateTask: () => this.taskState.update(), broadcast: () => { this.broadcastState().catch((error) => console.error(error)) }, schedulePartial: () => this.runtimeMonitoring.schedulePartialBroadcast(), recentTexts: () => this.state.clineMessages.slice(-3).map((message) => getString(message, "text")), commandOutputLimit: () => readPositiveIntEnv("VSCLINE_COMMAND_OUTPUT_CHARS", 12000), agentTranscriptLimit: () => readPositiveIntEnv("VSCLINE_AGENT_TRANSCRIPT_CHARS", 12000), logSkipped: (chunk) => this.logger.log("sidecar", "sdkAgentChunkSkippedForUi", summarizeAgentChunkForLog(chunk)) })
		this.taskSession.initialize(this.state.currentTaskItem ? "completed" : "idle")
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
	async publishChangeTranscript(text: string) { this.addMessage({ type: "say", say: "tool", text }); this.taskState.update(); await this.broadcastState() }
	updateTerminalActivity(text: string) { this.conversationProjection.activeTerminalActivityText = text; this.foldedProgressProjector.refresh(); this.taskState.update() }
	hasActiveTask() { return Boolean(this.state.currentTaskItem) }
	hasActivePartialText() { return Boolean(this.conversationProjection.activePartialTextTs) }
	handleTaskIdleLongRunning() { this.taskState.update(); this.broadcastState().catch((error) => console.error(error)) }
	hasStateSubscribers() { return this.streamPublisher?.hasStateSubscribers === true }
	getActivePartialSnapshot() { const message = this.state.clineMessages.find((item) => item.ts === this.conversationProjection.activePartialTextTs); const text = getString(message, "text"); return this.conversationProjection.activePartialTextTs && text.trim() ? { textLength: text.length } : null }
	handlePartialIdle() { this.taskState.update(); this.broadcastState().catch((error) => console.error(error)) }
	requestStateBroadcast() { this.broadcastState().catch((error) => console.error(error)) }

	dispose() {
		this.runtimeMonitoring.clearAll()
		this.terminalActivity?.dispose()
		this.changeTracking?.dispose()
		this.streamPublisher?.dispose()
		this.streamingRpc.clear()
		this.stateStreamRefresh.dispose()
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

	async requestToolApproval(request: ApprovalRequestedEvent): Promise<ToolApprovalResult> {
		return this.toolApproval.execute(request)
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
		this.taskSession.transition("awaiting_user", "question")
		this.taskSession.waitFor("question")
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
		this.taskState.update()
		await this.broadcastState()

		return new Promise<AskQuestionResult>((resolve) => {
			this.pendingQuestion = { resolve }
		})
	}

	handleSdkEvent(event: AgentRuntimeEvent) {
		if (shouldLogSdkEventForInteraction(event)) {
			this.logger.log("sdk->sidecar", "sdk.event", summarizeSdkEventForLog(event))
		}
		this.runtimeEvents.handle(event)
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
			this.taskState.update()
			await this.broadcastState()
			return grpcHandled(grpcError(requestId, message, false))
		}
	}

	private async handleStreamingRequest(key: string, requestId: string) {
		const command = decodeStreamingRpcCommand(key)
		if (!command) return null
		const result = await this.streamingRpc.handle(command, requestId)
		if (result.kind === "direct") return grpcHandled(...result.messages)
		if (result.kind === "payload") return grpcHandled(grpcResponse(requestId, result.payload, true))
		if (result.kind === "empty") return grpcHandled()
		return { handled: true, owner: "sidecar", reason: result.reason, webviewMessages: [] }
	}

	private async handleUnaryRequest(key: string, requestId: string, message: unknown) {
		const settingsCommand = decodeSettingsRpcCommand(key, message)
		if (settingsCommand) {
			const settingsResult = await this.settingsRpc.handle(settingsCommand)
			return grpcHandled(
				grpcResponse(requestId, settingsResult.payload, false),
				...(settingsResult.includeStateMessages ? this.buildStateMessages() : []),
			)
		}
		const accountCommand = decodeAccountRpcCommand(key, message)
		if (accountCommand) {
			const accountResult = await this.accountRpc.handle(accountCommand)
			return grpcHandled(
				grpcResponse(requestId, accountResult.payload, false),
				...(accountResult.includeStateMessages ? this.buildStateMessages() : []),
			)
		}
		const browserCommand = decodeBrowserRpcCommand(key, message)
		if (browserCommand) return grpcHandled(grpcResponse(requestId, await this.browserRpc.handle(browserCommand), false))
		const terminalCommand = decodeTerminalRpcCommand(key, message)
		if (terminalCommand) {
			const terminalResult = await this.terminalRpc.handle(terminalCommand)
			return grpcHandled(
				grpcResponse(requestId, terminalResult.payload, false),
				...(terminalResult.includeStateMessages ? this.buildStateMessages() : []),
			)
		}
		const taskCommand = decodeTaskRpcCommand(key, message)
		if (taskCommand) {
			const taskResult = await this.taskRpc.handle(taskCommand, requestId)
			return grpcHandled(
				grpcResponse(requestId, taskResult.payload, false),
				...(taskResult.includeStateMessages ? this.buildStateMessages() : []),
			)
		}
		const checkpointCommand = decodeCheckpointRpcCommand(key, message)
		if (checkpointCommand) {
			const checkpointResult = await this.checkpointRpc.handle(checkpointCommand)
			return grpcHandled(
				grpcResponse(requestId, checkpointResult.payload, false),
				...(checkpointResult.includeStateMessages ? this.buildStateMessages() : []),
			)
		}
		const hookCommand = decodeHookRpcCommand(key, message)
		if (hookCommand) return grpcHandled(grpcResponse(requestId, await this.hookRpc.handle(hookCommand), false))
		const scheduledAgentCommand = decodeScheduledAgentRpcCommand(key, message)
		if (scheduledAgentCommand) {
			const scheduledAgentResult = await this.scheduledAgentRpc.handle(scheduledAgentCommand)
			return grpcHandled(
				grpcResponse(requestId, scheduledAgentResult.payload, false),
				...(scheduledAgentResult.includeStateMessages ? this.buildStateMessages() : []),
			)
		}
		const worktreeCommand = decodeWorktreeRpcCommand(key, message)
		if (worktreeCommand) return grpcHandled(grpcResponse(requestId, await this.worktreeRpc.handle(worktreeCommand), false))
		const mcpCommand = decodeMcpRpcCommand(key, message)
		if (mcpCommand) {
			const mcpResult = await this.mcpRpc.handle(mcpCommand)
			if (mcpResult.error) return grpcHandled(grpcError(requestId, mcpResult.error, false))
			return grpcHandled(grpcResponse(requestId, mcpResult.payload, false), ...(mcpResult.publishToStreams ? this.buildMcpServerStreamMessages(mcpResult.payload) : []))
		}
		const modelCatalogCommand = decodeModelCatalogRpcCommand(key, message)
		if (modelCatalogCommand) return grpcHandled(grpcResponse(requestId, await this.modelCatalogRpc.handle(modelCatalogCommand), false))
		const fileCommand = decodeFileRpcCommand(key, message)
		if (fileCommand) {
			const fileResult = await this.fileRpc.handle(fileCommand)
			return grpcHandled(grpcResponse(requestId, fileResult.payload, false), ...(fileResult.includeStateMessages ? this.buildStateMessages() : []))
		}
		const instructionSettingsCommand = decodeInstructionSettingsRpcCommand(key, message)
		if (instructionSettingsCommand) return grpcHandled(grpcResponse(requestId, await this.instructionSettingsRpc.handle(instructionSettingsCommand), false))
		const uiWebCommand = decodeUiWebRpcCommand(key, message)
		if (uiWebCommand) return grpcHandled(grpcResponse(requestId, await this.uiWebRpc.handle(uiWebCommand), false))
		const pluginCommand = decodePluginRpcCommand(key)
		if (pluginCommand) return grpcHandled(grpcResponse(requestId, await this.pluginRpc.handle(pluginCommand), false))
		return null
	}

	private disposeStreamRequest(requestId: string) {
		return this.requireStreamPublisher().unsubscribe(requestId) || this.streamingRpc.unsubscribeMcp(requestId)
	}

	private logSlowGrpcRequest(key: string, startedAt: number, streaming: boolean) {
		const durationMs = Date.now() - startedAt
		const thresholdMs = readPositiveIntEnv("VSCLINE_SLOW_WEBVIEW_RPC_MS", 750)
		if (durationMs >= thresholdMs) {
			this.logger.log("sidecar", "webviewRpcSlow", { key, streaming, durationMs, thresholdMs })
		}
	}

	private async getPrimaryWorkspaceRoot() {
		const workspaceRoots = await this.host.workspaceClient.getWorkspacePaths({}).catch(() => [])
		return workspaceRoots[0] || String(this.state.currentTaskItem?.cwdOnTaskInitialization || process.cwd())
	}

	private setWorktreesFeatureFlag(enabled: boolean) {
		const current = asRecord(this.state.worktreesEnabled)
		this.state.worktreesEnabled = {
			...current,
			user: current.user !== false,
			featureFlag: enabled,
		}
	}

	private requireClineSdk() {
		if (!this.clineSdk) {
			throw new Error("LIG VS SDK runtime is not attached.")
		}
		return this.clineSdk
	}

	private requireMcp() {
		if (!this.mcp) {
			throw new Error("LIG VS MCP application service is not attached.")
		}
		return this.mcp
	}

	private buildMcpServerStreamMessages(response: unknown) {
		return this.streamingRpc.mcpMessages(response, (requestId, payload) => grpcResponse(requestId, payload, true))
	}

	private async startNewTask(request: { text: string; images?: string[]; files?: string[]; workspacePath?: string }, options: { broadcast?: boolean; requestId?: string } = {}) {
		const { text, images = [], files = [], workspacePath: requestedWorkspacePath = "" } = request
		const initialCwd = requestedWorkspacePath && fs.existsSync(requestedWorkspacePath)
			? path.resolve(requestedWorkspacePath)
			: process.cwd()
		this.startNewTaskFlow.execute({ text, images, files, requestedWorkspacePath, initialCwd, requestId: options.requestId || createId(), broadcast: options.broadcast !== false })
	}

	private async sendAskResponse(request: TaskPromptRequest, requestId = createId()) {
		if (!this.clineSdk) {
			throw new Error("LIG VS SDK runtime is not attached.")
		}

		const { responseType, images, files } = request
		const text = buildTaskInputWithAttachments(request.text, images, files)
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

		const answerText = buildTaskInputWithAttachments(request.answerText, images, files)
		if (await this.askResponseInteractions.handle({ responseType, text, answerText, images, files, activeSessionId: activeSessionId || "" })) return

		await this.sendUserMessage.execute({ requestId, prompt: request.text, transcriptText: text, images, files, delivery: normalizePromptDelivery(request.delivery), mode: this.state.mode === "plan" ? "plan" : "act", activeSessionId: activeSessionId || "", selectedSessionId })
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
		this.taskState.update()
		await this.broadcastState()
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

	private async handleFileChangedEvent(change: WorkspaceChange) { this.requireChangeTracking().track(change) }





	private wasRecentlyTracked(filePath: string) { return this.requireChangeTracking().wasRecentlyTracked(filePath) }

	private hasRecentlyTrackedChange() { return this.requireChangeTracking().hasRecentlyTrackedChange() }



	getUiLanguage(): "en" | "ko" {
		return getString(this.state, "uiLanguage") === "en" ? "en" : "ko"
	}

	private rememberToolSummary(tool: string, text: string) {
		const parsed = asRecord(tryParseJson(text) ?? {})
		const pathValue = getString(parsed, "path")
		const content = getString(parsed, "content")
		const summary = [tool, pathValue, content].filter(Boolean).join(": ")
		this.conversationProjection.rememberToolSummary(truncateText(summary || text, 2000))
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
		return this.conversationMessages.add(message)
	}

	private removeTerminalAskMessages() {
		this.conversationMessages.removeTerminalAsks()
	}

	private removeAskMessages(askKind: string) {
		this.conversationMessages.removeAsks(askKind)
	}

	private addToolActivityMessage(tool: string, input: Record<string, unknown>, fallback: unknown) {
		this.conversationRuntime.recordToolActivity(
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

	private getCurrentSessionId() {
		return this.clineSdk?.status.activeSessionId || String(this.state.currentTaskItem?.id || "")
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

	private async broadcastState() { await this.requireStreamPublisher().broadcastState() }

	private buildStateMessages() { return this.requireStreamPublisher().buildStateMessages() }

	private sendPartialMessage(message: Record<string, unknown> | undefined) { this.requireStreamPublisher().sendPartial(message) }

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

function readPositiveIntEnv(name: string, fallback: number) {
	const raw = process.env[name]
	if (!raw) {
		return fallback
	}

	const value = Number.parseInt(raw, 10)
	return Number.isFinite(value) && value > 0 ? value : fallback
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

function formatSdkErrorForUi(error: unknown, language: "en" | "ko") {
	const text = error instanceof Error ? error.message : String(error ?? "")
	if (text && text !== "[object Object]" && text !== "{}") {
		return text
	}

	return language === "en"
		? "The SDK request ended before a final response could be synchronized."
		: "SDK 요청이 최종 응답을 동기화하기 전에 종료되었습니다."
}
