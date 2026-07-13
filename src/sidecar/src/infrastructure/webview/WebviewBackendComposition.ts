import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { AskQuestionResult, ToolApprovalResult } from "../../application/ports/AgentInteraction"
import type { HostProviderPort } from "../../application/ports/HostProviderPort"
import type { InteractionLoggerPort } from "../../application/ports/InteractionLoggerPort"
import type { WebviewTransportPort } from "../../application/ports/WebviewTransportPort"
import type { WebviewApplicationPort } from "../../application/ports/WebviewApplicationPort"
import type { TaskLifecycleUseCase } from "../../application/useCases/TaskLifecycleUseCase"
import type { StatePersistenceUseCase } from "../../application/useCases/StatePersistenceUseCase"
import type { WebviewEnvelope } from "../../application/dto/WebviewRpc"
import {
	createInitialState,
	createMcpServersLazyResponse,
	createPersistedStateSnapshot,
	createSdkCoverageState,
	loadInitialState,
} from "./WebviewState"
import type { AgentRuntimeEvent } from "../../domain/agent/AgentRuntimeEvent"
import type { ApprovalRequestedEvent } from "../../domain/agent/AgentRuntimeEvent"
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
import { TaskPromptFlow } from "../../features/chat/TaskPromptFlow"
import { ClearTaskHandler } from "../../features/chat/clearTask/ClearTaskHandler"
import type { BrowserSettings } from "../../features/browser/BrowserHandler"
import { ApprovalCoordinator } from "../../features/approvals/ApprovalCoordinator"
import { ToolApprovalFlow } from "../../features/approvals/ToolApprovalFlow"
import { rebindTaskHistoryId, upsertTaskHistoryItem } from "../../features/taskHistory/TaskHistoryCollection"
import {
	isOAuthTokenBlobProvider,
	oauthCredentialsField,
	providerAuthLabel,
} from "../../application/services/ProviderIdentity"
import {
	checkIsImageUrl,
	fetchOpenGraphData,
} from "../browser/BrowserDevToolsAdapter"
import { BrowserToolEventFlow } from "../../features/browser/BrowserToolEventFlow"
import {
	discoverLocalPlugins,
	getSettingsPath,
	getSidecarDataPath,
} from "../persistence/LocalAutomationStore"
import { ConversationProjectionState, type ToolActivityEntry } from "../../features/conversation/ConversationProjectionState"
import { WebviewStreamPublisher } from "./WebviewStreamPublisher"
import { WebviewFeatureRegistry, type WebviewFeatures } from "./WebviewFeatureRegistry"
import { TaskSnapshotStore } from "../../features/taskHistory/TaskSnapshotStore"
import { TaskStateCoordinator } from "../../features/taskHistory/TaskStateCoordinator"
import { TaskHistorySync } from "../../features/taskHistory/TaskHistorySync"
import { TaskHistoryCommands } from "../../features/taskHistory/TaskHistoryCommands"
import { TaskTranscriptHydrator } from "../../features/taskHistory/TaskTranscriptHydrator"
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
import { ToolRuntimePolicy } from "../configuration/ToolRuntimePolicy"
import { SettingsRpcHandler } from "../../features/settings/SettingsRpcHandler"
import { AccountRpcHandler } from "../../features/providers/AccountRpcHandler"
import { BrowserRpcHandler } from "../../features/browser/BrowserRpcHandler"
import { TerminalRpcHandler } from "../../features/terminal/TerminalRpcHandler"
import { TaskRpcHandler } from "../../features/chat/TaskRpcHandler"
import { CheckpointRpcHandler } from "../../features/checkpoints/CheckpointRpcHandler"
import { HookRpcHandler } from "../../features/hooks/HookRpcHandler"
import { ScheduledAgentRpcHandler } from "../../features/scheduledAgents/ScheduledAgentRpcHandler"
import { WorktreeRpcHandler } from "../../features/worktrees/WorktreeRpcHandler"
import { McpRpcHandler } from "../../features/mcp/McpRpcHandler"
import { ModelCatalogRpcHandler } from "../../features/providers/ModelCatalogRpcHandler"
import { FileRpcHandler } from "../../features/files/FileRpcHandler"
import { InstructionSettingsRpcHandler } from "../../features/settings/InstructionSettingsRpcHandler"
import { UiWebRpcHandler } from "../../features/web/UiWebRpcHandler"
import { PluginRpcHandler } from "../../features/plugins/PluginRpcHandler"
import { StreamingRpcHandler } from "../../features/web/StreamingRpcHandler"
import { StateStreamRefreshCoordinator } from "../../features/web/StateStreamRefreshCoordinator"
import { summarizeAgentChunkForLog, summarizeClineMessageForLog } from "./WebviewInteractionLogSupport"
import { formatEmptyModelResponseForUi, formatProviderErrorForTranscript, formatSdkErrorForUi, isSessionNotFoundError, stringify } from "./RuntimeErrorFormatter"
import { WebviewUnaryRpcRouter } from "./WebviewUnaryRpcRouter"
import { WebviewStreamingRpcRouter } from "./WebviewStreamingRpcRouter"
import { WebviewRpcIngress } from "./WebviewRpcIngress"
import { WebviewRuntimeEventIngress } from "./WebviewRuntimeEventIngress"
import { AgentSdkConfigBuilder } from "../configuration/AgentSdkConfigBuilder"
import { resolveEffectiveModelId } from "../models/EffectiveModelResolver"
import { RuntimeModelContext } from "../models/RuntimeModelContext"
import { AutoApprovalNotifier } from "../notifications/AutoApprovalNotifier"
import { buildTaskInputWithAttachments, normalizeSdkImageInputs } from "../conversation/AttachmentNormalization"
import { createHistoryItem, createId, sdkSessionToHistoryItem } from "../conversation/TaskHistoryProjection"
import { extractCompletionTextFromResult } from "../conversation/CompletionExtraction"
import { PartialTextProjector } from "../conversation/PartialTextProjector"
import { FoldedProgressProjector } from "../conversation/FoldedProgressProjector"
import { ConversationRuntimeProjector } from "../conversation/ConversationRuntimeProjector"
import { ConversationCleanupCoordinator } from "../conversation/ConversationCleanupCoordinator"
import { ToolApprovalPromptProjector } from "../conversation/ToolApprovalPromptProjector"
import { ConversationActivityProjector } from "../conversation/ConversationActivityProjector"
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
	buildResumedConversationMessages,
} from "../conversation/ResumedConversationProjection"
import {
	parsePatchPaths,
	summarizeCommandLabel,
	sanitizeConsoleOutput,
	stripCommandSentinel,
	firstString,
	shouldAutoApproveTool,
	mapToolName,
} from "../conversation/ToolCommandFormatting"
import {
	isJsonObjectString,
	isEmptyJsonObjectString,
	isEmptyTranscriptPlaceholder,
	isEmptyPlainObject,
	toProtoAsk,
	toProtoSay,
	stripLegacyMcpContext,
} from "../conversation/ConversationMessageProjection"
import {
	sdkMessagesToClineMessages,
	sdkMessageTimestamp,
	normalizeTimestamp,
	stableSessionBaseTimestamp,
	hashString,
} from "../conversation/SdkMessageTranscriptProjection"
import {
	sdkContentToVisibleAssistantText,
	sdkContentToReasoningText,
	sdkContentToToolActivityEntries,
} from "../conversation/SdkContentConversion"
import {
	agentChunkRecordToTerminalResult,
	agentChunkStringToTranscriptText,
	agentChunkStringToFoldedReasoningText,
	parseJsonObjectSequence,
	agentChunkRecordToTranscriptText,
	agentChunkRecordToFoldedReasoningText,
	isKnownAgentEventRecord,
	agentContentEventToText,
	unknownAgentChunkTextToTranscriptText,
} from "../conversation/AgentChunkTranscriptConversion"
import {
	stripRawToolCallMarkup,
} from "../conversation/TranscriptNormalization"
import {
	toolTranscriptToActivityEntries,
	formatToolActivitySection,
	normalizeTerminalOutputText,
	uniqueToolActivityEntries,
	splitToolPaths,
	looksLikeCommandText,
	uniqueStrings,
} from "../conversation/ToolActivityFormatting"
import {
	type OAuthTokenExchangeConfig,
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
	isWebFetchEnabled,
	webFetchDisabledReason,
} from "../configuration/ProviderConfiguration"
import { createUnauthenticatedAccountState } from "../auth/ProviderAuthSupport"

export class WebviewBackendComposition implements WebviewApplicationPort {
	private readonly features = new WebviewFeatureRegistry()
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
	private readonly taskPrompts: TaskPromptFlow
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
	private readonly conversationActivity: ConversationActivityProjector
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
	private readonly runtimeEventIngress: WebviewRuntimeEventIngress
	private readonly semanticEvents: AgentEventDispatcher
	private readonly runtimeMonitoring: RuntimeMonitoringCoordinator
	private readonly taskSession: TaskSessionCoordinator
	private readonly apiConfigurationProfiles: ApiConfigurationProfileManager
	private readonly settingsMutations: SettingsMutationHandler
	private readonly toolRuntimePolicy: ToolRuntimePolicy
	private readonly settingsRpc: SettingsRpcHandler
	private readonly accountRpc: AccountRpcHandler
	private readonly browserRpc: BrowserRpcHandler
	private readonly browserToolEvents: BrowserToolEventFlow
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
	private readonly streamingRpcRouter: WebviewStreamingRpcRouter
	private readonly unaryRpcRouter: WebviewUnaryRpcRouter
	private readonly rpcIngress: WebviewRpcIngress
	private readonly stateStreamRefresh: StateStreamRefreshCoordinator
	private readonly sdkConfigBuilder: AgentSdkConfigBuilder
	private readonly modelContext: RuntimeModelContext
	private readonly autoApprovalNotifier: AutoApprovalNotifier
	private readonly hookLifecycle: HookLifecycleCoordinator
	private sdkRunGeneration = 0
	private runtimeSettingsRevision = 0
	private activeSessionRuntimeSettingsRevision = 0

	constructor(
		private readonly host: HostProviderPort,
		private readonly transport: WebviewTransportPort,
		private readonly logger: InteractionLoggerPort,
		private readonly stateStore: StatePersistenceUseCase,
		private readonly taskLifecycle: TaskLifecycleUseCase,
	) {
		this.state = loadInitialState(this.stateStore.load())
		this.features.attach("streamPublisher", new WebviewStreamPublisher(this.transport, this.logger, () => this.serializeState(), () => this.activeCorrelationId()))
		this.modelContext = new RuntimeModelContext({ configuration: () => asRecord(this.state.apiConfiguration), mode: () => this.state.mode === "plan" ? "plan" : "act", defaultModelId: () => process.env.CLINE_MODEL_ID || "", defaultOllamaModelId: () => process.env.OLLAMA_MODEL || process.env.CLINE_MODEL_ID || "", maxResumedConversationChars: RESUMED_CONVERSATION_MAX_CHARS })
		this.autoApprovalNotifier = new AutoApprovalNotifier(this.host.windowClient, this.logger)
		this.toolRuntimePolicy = new ToolRuntimePolicy({ autoApprovalSettings: () => this.state.autoApprovalSettings, browserSettings: () => this.state.browserSettings, mode: () => this.state.mode === "plan" ? "plan" : "act", writeWebToolState: (state) => { this.state.clineWebToolsEnabled = state as typeof this.state.clineWebToolsEnabled }, logger: this.logger })
		this.taskSnapshots = new TaskSnapshotStore(this.state.taskSnapshots, (snapshots) => { this.state.taskSnapshots = snapshots })
		this.taskState = new TaskStateCoordinator({ snapshots: this.taskSnapshots, readCurrentTask: () => this.state.currentTaskItem, writeCurrentTask: (task) => { this.state.currentTaskItem = task }, readMessages: () => this.state.clineMessages, readHistory: () => this.state.taskHistory, writeHistory: (history) => { this.state.taskHistory = history }, schedulePersist: () => this.schedulePersistedStateSave() })
		this.runtimeMonitoring = new RuntimeMonitoringCoordinator({
			taskActivity: () => this.requireTaskActivity(),
			optionalTaskActivity: () => this.features.optional("taskActivity"),
			partialState: () => this.requirePartialStateScheduler(),
			optionalPartialState: () => this.features.optional("partialState"),
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
		this.toolApproval = new ToolApprovalFlow({ mapToolName: (toolName) => mapToolName(toolName), isPlanModeBlocked: (mappedToolName) => this.toolRuntimePolicy.isBlockedInCurrentMode(mappedToolName), blockedReason: () => this.toolApprovalPrompts.blockedReason(this.getUiLanguage()), addInfo: (text) => { this.conversationMessages.add({ type: "say", say: "info", text }) }, currentSessionId: () => this.taskSession.currentSessionId, preToolUse: (context) => this.hookLifecycle.preToolUse(context), shouldAutoApprove: (toolName) => shouldAutoApproveTool(toolName, this.state.autoApprovalSettings), notifyAutoApproved: (mappedToolName, input) => this.autoApprovalNotifier.notify(asRecord(this.state.autoApprovalSettings).enableNotifications === true, mappedToolName, input), buildPrompt: (mappedToolName, input, approvalRequest) => this.toolApprovalPrompts.build(mappedToolName, input, approvalRequest), beginApproval: () => { this.taskSession.transition("awaiting_user", "tool-approval"); this.taskSession.waitFor("tool_approval") }, addAsk: ({ ask, text }) => { this.conversationMessages.add({ type: "ask", ask, text }) }, updateTask: () => this.taskState.update(), broadcast: () => this.broadcastState(), requestApproval: () => this.approvals.request(), logRequest: (details) => this.logger.log("sdk->sidecar", "toolApproval.request", details), log: (event, details) => this.logger.log("sidecar", event, details) })
		this.conversationMessages = new ConversationMessageStore({ read: () => this.state.clineMessages, write: (messages) => { this.state.clineMessages = messages }, persist: () => this.schedulePersistedStateSave(), publishPartial: (message) => this.sendPartialMessage(message), log: (event, details) => this.logger.log("sidecar", event, details) })
		this.hookLifecycle = new HookLifecycleCoordinator({ execution: () => this.requireHookExecution(), workspaceRoot: () => this.getPrimaryWorkspaceRoot(), enabled: () => this.state.hooksEnabled !== false, addMessage: (message) => this.conversationMessages.add(message), nextTimestamp: () => this.conversationMessages.nextTimestamp(), upsertMessage: (timestamp, updates) => this.conversationMessages.upsert(timestamp, updates), updateTask: () => this.taskState.update(), broadcast: () => this.broadcastState().catch((error) => { console.error(error) }) })
		this.clearTaskHandler = new ClearTaskHandler(() => this.clineSdk, { transition: (status, source) => this.taskSession.transition(status, source), advanceRunGeneration: () => { this.sdkRunGeneration++ }, currentSessionId: () => this.clineSdk?.status.activeSessionId || String(this.state.currentTaskItem?.id || ""), markClosing: (sessionId) => { this.taskSession.markClosing(sessionId) }, rememberSnapshot: (sessionId) => { if (this.state.currentTaskItem && this.state.clineMessages.length > 0) { const taskId = String(this.state.currentTaskItem.id || sessionId); if (taskId) this.taskState.remember(taskId, this.state.currentTaskItem, this.state.clineMessages) } }, clearProjection: () => { this.conversationCleanup.clearProjection() }, clearInteractions: () => { this.approvals.clear({ approved: false, reason: "Task was closed." }); this.pendingQuestion?.resolve(""); this.pendingQuestion = null }, clearTaskState: () => { this.state.currentTaskItem = null; this.state.clineMessages = [] }, resetLifecycle: (source) => { this.taskSession.reset(source) }, persist: () => this.stateStore.save(createPersistedStateSnapshot(this.state)), broadcast: () => this.broadcastState(), log: (event, details) => this.logger.log("sidecar", event, details) })
		this.cancelTaskFlow = new CancelTaskFlow({ beginCancel: () => Boolean(this.taskSession.transition("cancelling", "cancel-request")), currentStatus: () => this.taskSession.status, advanceRunGeneration: () => { this.sdkRunGeneration++ }, hookSessionId: () => this.clineSdk?.status.activeSessionId || String(this.state.currentTaskItem?.id || ""), activeSessionId: () => this.clineSdk?.status.activeSessionId || "", cancelRemote: async (sessionId) => { const handler = this.features.optional("cancelTask"); if (handler) await handler.execute({ sessionId }) }, clearProjection: () => { this.conversationCleanup.clearProjection(); this.conversationCleanup.finalizeOpenPartials(); this.conversationMessages.removeTerminalAsks() }, addInfo: (text) => { this.conversationMessages.add({ type: "say", say: "info", text }) }, updateTask: () => this.taskState.update(), runHook: (sessionId) => this.hookLifecycle.run("TaskCancel", { sessionId }), completeCancel: () => { this.taskSession.transition("idle", "cancel-complete") }, broadcast: () => this.broadcastState(), log: (event, details) => this.logger.log("sidecar", event, details) })
		this.agentRunRecovery = new AgentRunRecoveryFlow({ currentGeneration: () => this.sdkRunGeneration, activeText: () => this.partialTextProjector.activeText(), hasAssistantText: () => this.taskCompletion.hasAssistantAfterLastUser(), hydrate: (sessionId, source) => this.taskTranscriptHydrator.hydrateCurrent(sessionId, source, true), finishTask: (sessionId, status, text) => this.taskCompletion.finish(sessionId, status, text), updateTask: () => this.taskState.update(), broadcast: () => this.broadcastState(), projectFailure: (source, error) => { this.runtimeMonitoring.clearTaskActivity(); this.taskSession.transition("failed", `sdk-error:${source}`); this.runtimeMonitoring.clearPartialIdle(); this.conversationActivity.clearReasoning(); this.conversationMessages.add({ type: "say", say: "error", text: formatSdkErrorForUi(error, this.getUiLanguage()) }) }, log: (event, details) => this.logger.log("sidecar", event, details) })
		this.agentRunCompletion = new AgentRunCompletionFlow({ decode: (result, fallbackSessionId) => { const resultRecord = asRecord(result); const agentResult = asRecord(resultRecord.result ?? result); return { sessionId: getString(resultRecord, "sessionId") || fallbackSessionId || String(this.state.currentTaskItem?.id || ""), empty: Object.keys(agentResult).length === 0, text: extractCompletionTextFromResult(agentResult, resultRecord), finishReason: getString(agentResult, "finishReason") || getString(agentResult, "status") || "completed" } }, currentGeneration: () => this.sdkRunGeneration, currentTaskId: () => String(this.state.currentTaskItem?.id || ""), activeSessionId: () => this.clineSdk?.status.activeSessionId || "", bindSession: (sessionId) => this.taskSession.bindSession(sessionId), isCurrentSession: (sessionId) => this.taskSession.isCurrentResult(sessionId), hydrate: (sessionId, source) => this.taskTranscriptHydrator.hydrateCurrent(sessionId, source, true), activeText: () => this.partialTextProjector.activeText(), hasAssistantText: () => this.taskCompletion.hasAssistantAfterLastUser(), lastActivityReason: () => this.features.optional("taskActivity")?.reason || "", finishTask: (sessionId, status, text) => this.taskCompletion.finish(sessionId, status, text), failEmpty: (sessionId) => this.taskCompletion.fail(sessionId, formatEmptyModelResponseForUi(this.getUiLanguage())), finalizePartial: () => this.conversationCleanup.finalizeOpenPartials(), addCompletionMarker: (status) => this.taskCompletion.addMarker(status), updateTask: () => this.taskState.update(), broadcast: () => this.broadcastState(), log: (event, details) => this.logger.log("sidecar", event, details) })
		this.sendOrResumeSession = new SendOrResumeSessionFlow(() => this.clineSdk, { activeSettingsRevision: () => this.activeSessionRuntimeSettingsRevision, settingsRevision: () => this.runtimeSettingsRevision, markClosing: (sessionId, closing) => { if (closing) this.taskSession.markClosing(sessionId); else this.taskSession.prepareActivation(sessionId) }, send: (command) => this.features.require("sendMessage").execute(command), resume: (sessionId, command, textLength) => this.resumeSession.execute(sessionId, command, textLength), markSend: (sessionId) => this.runtimeMonitoring.markSdkSend(sessionId), markError: (sessionId, error) => this.runtimeMonitoring.markError(sessionId, error), isSessionNotFound: (error) => isSessionNotFoundError(error), log: (event, details) => this.logger.log("sidecar", event, details) })
		this.resumeSession = new ResumeSessionFlow({ isRuntimeAvailable: () => Boolean(this.clineSdk), workspaceRoots: () => this.host.workspaceClient.getWorkspacePaths({}), currentCwd: () => String(this.state.currentTaskItem?.cwdOnTaskInitialization || ""), prepareTask: (sessionId, prompt, cwd) => { const taskItem = this.state.currentTaskItem || createHistoryItem(sessionId, prompt, cwd, this.modelContext.modelId()); this.state.currentTaskItem = { ...taskItem, id: sessionId, cwdOnTaskInitialization: cwd, modelId: String(taskItem.modelId || "") || this.modelContext.modelId() }; this.state.taskHistory = upsertTaskHistoryItem(this.state.taskHistory, this.state.currentTaskItem); return { title: String(taskItem.task || "").trim() } }, noteActivity: (reason) => this.runtimeMonitoring.noteActivity(reason), updateTask: () => this.taskState.update(), broadcast: () => this.broadcastState(), runResumeHook: (context) => { void this.hookLifecycle.run("TaskResume", context) }, buildInitialMessages: (prompt) => buildResumedConversationMessages(this.state.clineMessages, prompt, this.modelContext.resumedConversationCharBudget()), normalizeImages: (images) => normalizeSdkImageInputs([...images]), buildConfig: (cwd, sessionId) => this.sdkConfigBuilder.build(cwd, sessionId), toolPolicies: () => this.toolRuntimePolicy.currentPolicies(), start: (command) => this.features.require("startTask").execute(command), markSettingsRevisionActive: () => { this.activeSessionRuntimeSettingsRevision = this.runtimeSettingsRevision }, log: (event, details) => this.logger.log("sidecar", event, details) })
		this.launchAgentSession = new LaunchAgentSessionFlow({ isRuntimeAvailable: () => Boolean(this.clineSdk), buildConfig: (cwd, sessionId) => this.sdkConfigBuilder.build(cwd, sessionId), toolPolicies: () => this.toolRuntimePolicy.currentPolicies(), markSend: (sessionId) => this.runtimeMonitoring.markSdkSend(sessionId), nextGeneration: () => ++this.sdkRunGeneration, currentGeneration: () => this.sdkRunGeneration, start: (command) => this.features.require("startTask").execute(command), markSettingsRevisionActive: () => { this.activeSessionRuntimeSettingsRevision = this.runtimeSettingsRevision }, complete: (result, sessionId, source, generation) => this.agentRunCompletion.complete(result, sessionId, source, generation), recover: (sessionId, source, generation, error) => this.agentRunRecovery.recover(sessionId, source, generation, error), log: (event, details) => this.logger.log("sidecar", event, details) })
		this.prepareNewTask = new PrepareNewTaskFlow({ isRuntimeAvailable: () => Boolean(this.clineSdk), workspaceRoots: () => this.host.workspaceClient.getWorkspacePaths({}), resolveWorkspacePath: (requestedPath) => requestedPath && fs.existsSync(requestedPath) ? path.resolve(requestedPath) : null, updateTask: () => this.taskState.update(), publishPreparing: () => this.sendPartialMessage(this.state.clineMessages.find((message) => message.ts === this.conversationProjection.activeReasoningTextTs)), activeSessionId: () => this.requireClineSdk().status.activeSessionId || "", markClosing: (sessionId) => { this.taskSession.markClosing(sessionId) }, stopSession: (sessionId) => this.requireClineSdk().stop({ sessionId }), runHook: (name, context) => { void this.hookLifecycle.run(name, context) }, normalizeImages: (images) => normalizeSdkImageInputs(images), launch: (params, cwd, sessionId) => this.launchAgentSession.execute(params, cwd, sessionId, "startSession"), projectError: async (error) => { this.runtimeMonitoring.clearTaskActivity(); this.conversationMessages.add({ type: "say", say: "error", text: error instanceof Error ? error.message : String(error) }); this.taskState.update(); await this.broadcastState() }, log: (event, details) => this.logger.log("sidecar", event, details) })
		this.startNewTaskFlow = new StartNewTaskFlow({ isRuntimeAvailable: () => Boolean(this.clineSdk), transitionStarting: () => { this.taskSession.transition("starting", "start-new-task") }, createTask: (input) => createHistoryItem(createId(), input.text, input.initialCwd, this.modelContext.modelId()), startLatency: (requestId, taskId, textLength) => this.runtimeMonitoring.startLatency(requestId, "newTask", taskId, textLength), beginConversation: () => { this.state.clineMessages = []; this.conversationProjection.beginTask() }, selectTask: (task) => { this.state.currentTaskItem = task; this.state.taskHistory = upsertTaskHistoryItem(this.state.taskHistory, task) }, addUserTask: (text, images, files) => { this.conversationMessages.add({ type: "say", say: "task", text, images, files }) }, showPreparing: () => this.foldedProgressProjector.upsertReasoning(this.state.uiLanguage === "en" ? "Preparing response." : "응답을 준비하는 중입니다."), noteActivity: (reason) => this.runtimeMonitoring.noteActivity(reason), updateTask: () => this.taskState.update(), persist: () => this.schedulePersistedStateSave(), broadcast: () => { this.broadcastState().catch((error) => console.error(error)) }, prepare: (input, task) => { void this.prepareNewTask.execute({ text: input.text, images: input.images, files: input.files, requestedWorkspacePath: input.requestedWorkspacePath, initialCwd: input.initialCwd, taskItem: task }) } })
		this.askResponseInteractions = new AskResponseInteractionFlow({ hasPendingApproval: () => this.approvals.hasPending, hasPendingQuestion: () => Boolean(this.pendingQuestion), takeApproval: () => this.approvals.take() ?? undefined, takeQuestion: () => { const pending = this.pendingQuestion; this.pendingQuestion = null; return pending?.resolve }, transitionStreaming: (source) => { this.taskSession.transition("streaming", source) }, removeFollowup: () => this.conversationMessages.removeAsks("followup"), addFeedback: (text, images, files) => { this.conversationMessages.add({ type: "say", say: "user_feedback", text, images, files }) }, updateTask: () => this.taskState.update(), broadcast: () => this.broadcastState(), log: (event, details) => this.logger.log("sidecar", event, details) })
		this.sendUserMessage = new SendUserMessageFlow({ hasPendingApproval: () => this.approvals.hasPending, hasPendingQuestion: () => Boolean(this.pendingQuestion), clearPending: () => { this.approvals.clear({ approved: false, reason: "Superseded by resumed chat message." }); this.pendingQuestion?.resolve(""); this.pendingQuestion = null }, startNewTask: (input) => this.taskPrompts.start({ text: input.prompt, images: input.images, files: input.files }, { broadcast: true, requestId: input.requestId }), startLatency: (requestId, sessionId, textLength) => this.runtimeMonitoring.startLatency(requestId, "askResponse", sessionId, textLength), transitionStarting: () => { this.taskSession.transition("starting", "send-response") }, projectUserMessage: (text) => { this.conversationMessages.removeTerminalAsks(); const message = this.conversationMessages.add({ type: "say", say: "user_feedback", text }); this.foldedProgressProjector.beginReasoning(); return message }, showPreparing: () => this.foldedProgressProjector.upsertReasoning(this.state.uiLanguage === "en" ? "Preparing response." : "응답을 준비하는 중입니다."), persist: () => this.schedulePersistedStateSave(), publishPartial: (message) => this.sendPartialMessage(message !== null && typeof message === "object" && !Array.isArray(message) ? message as Record<string, unknown> : undefined), broadcast: () => { this.broadcastState().catch((error) => console.error(error)) }, normalizeImages: (images) => normalizeSdkImageInputs(images), runHook: (context) => { void this.hookLifecycle.run("UserPromptSubmit", context) }, nextGeneration: () => ++this.sdkRunGeneration, currentGeneration: () => this.sdkRunGeneration, send: (sessionId, command, textLength) => this.sendOrResumeSession.execute(sessionId, command, textLength), resultSessionId: (result, fallback) => getString(asRecord(result), "sessionId") || fallback, complete: (result, sessionId, generation) => this.agentRunCompletion.complete(result, sessionId, "send", generation), recover: (sessionId, generation, error) => this.agentRunRecovery.recover(sessionId, "send", generation, error), log: (event, details) => this.logger.log("sidecar", event, details) })
		this.taskPrompts = new TaskPromptFlow({ startFlow: this.startNewTaskFlow, interactionFlow: this.askResponseInteractions, sendFlow: this.sendUserMessage, isRuntimeAvailable: () => Boolean(this.clineSdk), activeSessionId: () => this.clineSdk?.status.activeSessionId || "", selectedSessionId: () => String(this.state.currentTaskItem?.id || ""), mode: () => this.state.mode === "plan" ? "plan" : "act", hasPendingApproval: () => this.approvals.hasPending, hasPendingQuestion: () => Boolean(this.pendingQuestion), resolveInitialCwd: (requestedWorkspacePath) => requestedWorkspacePath && fs.existsSync(requestedWorkspacePath) ? path.resolve(requestedWorkspacePath) : process.cwd(), buildTranscript: (text, images, files) => buildTaskInputWithAttachments(text, images, files), createRequestId: () => createId(), log: (event, details) => this.logger.log("sidecar", event, details) })
		this.compactSession = new CompactSessionFlow({ isRuntimeAvailable: () => Boolean(this.clineSdk), activeSessionId: () => this.clineSdk?.status.activeSessionId || "", selectedSessionId: () => String(this.state.currentTaskItem?.id || ""), language: () => this.state.uiLanguage === "en" ? "en" : "ko", mode: () => this.state.mode === "plan" ? "plan" : "act", addError: (text) => { this.conversationMessages.add({ type: "say", say: "error", text }) }, transitionStarting: () => { this.taskSession.transition("starting", "compact") }, startLatency: (requestId, sessionId, textLength) => this.runtimeMonitoring.startLatency(requestId, "askResponse", sessionId, textLength), showProgress: (text) => { this.foldedProgressProjector.beginReasoning(); this.foldedProgressProjector.upsertReasoning(text) }, persist: () => this.schedulePersistedStateSave(), broadcast: () => this.broadcastState(), nextGeneration: () => ++this.sdkRunGeneration, currentGeneration: () => this.sdkRunGeneration, send: (sessionId, command, textLength) => this.sendOrResumeSession.execute(sessionId, command, textLength), resultSessionId: (result, fallback) => getString(asRecord(result), "sessionId") || fallback, complete: (result, sessionId, generation) => this.agentRunCompletion.complete(result, sessionId, "compact", generation), recover: (sessionId, generation, error) => this.agentRunRecovery.recover(sessionId, "compact", generation, error), log: (event, details) => this.logger.log("sidecar", event, details) })
		this.apiConfigurationProfiles = new ApiConfigurationProfileManager({ readConfiguration: () => asRecord(this.state.apiConfiguration), writeConfiguration: (configuration) => { this.state.apiConfiguration = configuration as typeof this.state.apiConfiguration }, readProfiles: () => this.state.apiConfigurationProfiles, writeProfiles: (profiles) => { this.state.apiConfigurationProfiles = profiles }, readActiveId: () => this.state.activeApiConfigurationProfileId, writeActiveId: (profileId) => { this.state.activeApiConfigurationProfileId = profileId }, readSeparateModels: () => this.state.planActSeparateModelsSetting, writeSeparateModels: (enabled) => { this.state.planActSeparateModelsSetting = enabled } })
		this.settingsMutations = new SettingsMutationHandler({ state: () => this.state as unknown as Record<string, unknown>, profiles: this.apiConfigurationProfiles, refreshWebTools: () => this.toolRuntimePolicy.refreshWebToolState(), runtimeChanged: () => { this.runtimeSettingsRevision++; this.logger.log("sidecar", "runtimeSettingsChanged", { runtimeSettingsRevision: this.runtimeSettingsRevision, activeSessionRuntimeSettingsRevision: this.activeSessionRuntimeSettingsRevision }) } })
		this.settingsRpc = new SettingsRpcHandler({ state: () => this.state as unknown as Record<string, unknown>, applySettings: (settings) => this.settingsMutations.apply(settings), persist: () => this.stateStore.save(createPersistedStateSnapshot(this.state)), broadcast: () => this.broadcastState(), clearPersistedState: () => this.stateStore.clear(), resetState: () => { Object.assign(this.state, createInitialState()) }, clearTask: () => this.clearTaskHandler.execute() })
		this.accountRpc = new AccountRpcHandler({ authorization: () => this.requireOAuthAuthorization(), callback: () => this.requireOAuthCallbackHandler(), authActions: () => this.requireProviderAuthActions(), credentials: () => this.requireProviderCredentials(), configuration: () => asRecord(this.state.apiConfiguration), mutateConfiguration: (updates, deletes) => { const next = { ...asRecord(this.state.apiConfiguration), ...updates }; for (const field of deletes) delete next[field]; this.state.apiConfiguration = normalizeApiConfiguration(next) as typeof this.state.apiConfiguration }, syncProfiles: () => this.apiConfigurationProfiles.syncActive(), setCodexAuthenticated: (authenticated) => { this.state.openAiCodexIsAuthenticated = authenticated }, persist: () => this.stateStore.save(createPersistedStateSnapshot(this.state)), broadcast: () => this.broadcastState(), log: (event, details) => this.logger.log("sidecar", event, details) })
		this.browserRpc = new BrowserRpcHandler({ browser: () => this.requireBrowserHandler(), settings: () => this.getBrowserSettings() })
		this.browserToolEvents = new BrowserToolEventFlow({ browser: () => this.requireBrowserHandler(), settings: () => this.getBrowserSettings(), addMessage: (message) => { this.conversationMessages.add(message) }, updateTask: () => this.taskState.update(), broadcast: () => this.broadcastState() })
		this.terminalRpc = new TerminalRpcHandler(this.host.workspaceClient)
		this.sdkConfigBuilder = new AgentSdkConfigBuilder({ state: () => this.state as unknown as Record<string, unknown>, resolveModelId: (configuration, providerId, modePrefix, baseUrl) => resolveEffectiveModelId(configuration, providerId, modePrefix, baseUrl, (modelId) => this.applyDefaultOllamaModel(modelId)), scheduledAgentsEnabled: () => this.isScheduledAgentsEnabled(), log: (event, details) => this.logger.log("sidecar", event, details) })
		this.taskHistorySync = new TaskHistorySync({ isAvailable: () => Boolean(this.clineSdk), listHistory: () => this.clineSdk?.listHistory({ limit: 200 }) ?? Promise.resolve(null), projectSession: (session) => sdkSessionToHistoryItem(asRecord(session)), readHistory: () => this.state.taskHistory, writeHistory: (history) => { this.state.taskHistory = history }, broadcast: () => this.broadcastState(), log: (event, details) => this.logger.log("sidecar", event, details) })
		this.taskHistoryCommands = new TaskHistoryCommands({ readHistory: () => this.state.taskHistory, writeHistory: (history) => { this.state.taskHistory = history }, readCurrentTask: () => this.state.currentTaskItem, writeCurrentTask: (task) => { this.state.currentTaskItem = task }, clearMessages: () => { this.state.clineMessages = [] }, clearLiveInteraction: (reason) => this.conversationCleanup.clearLiveInteraction(reason), markDeleted: (taskId) => this.taskHistorySync.markDeleted(taskId), removeDeleted: (history) => this.taskHistorySync.removeDeleted(history), listRemoteTaskIds: async () => { if (!this.clineSdk) return []; const sessions = await this.clineSdk.listHistory({ limit: 1000 }); return Array.isArray(sessions) ? sessions.map((session) => getString(asRecord(session), "id") || getString(asRecord(session), "sessionId")).filter(Boolean) : [] }, deleteRemote: (taskId) => this.clineSdk?.deleteSession({ sessionId: taskId }) ?? Promise.resolve(undefined), updateRemoteFavorite: (taskId, isFavorited) => this.clineSdk?.updateSession({ sessionId: taskId, metadata: { isFavorited } }) ?? Promise.resolve(undefined), getSnapshot: (taskId) => this.taskState.getSnapshot(taskId), rememberSnapshot: (taskId, task, messages) => this.taskState.remember(taskId, task, messages), forgetSnapshot: (taskId) => this.taskState.forget(taskId), clearSnapshots: () => this.taskState.clearSnapshots(), persist: () => this.stateStore.save(createPersistedStateSnapshot(this.state)), log: (event, details) => this.logger.log("sidecar", event, details) })
		this.taskRpc = new TaskRpcHandler({ hasPendingQuestion: () => Boolean(this.pendingQuestion), hasCurrentTask: () => Boolean(this.state.currentTaskItem), start: (request, requestId) => this.taskPrompts.start(request, { broadcast: true, requestId }), respond: (request, requestId) => this.taskPrompts.respond(request, requestId), compact: (requestId) => this.compactSession.execute(requestId), cancel: () => this.cancelTaskFlow.execute(), clear: () => this.clearTaskHandler.execute(), refreshHistory: async (source) => { const startedAt = Date.now(); await this.taskHistorySync.refresh(); this.logger.log("sidecar", "stateHydration.historyRefreshed", { source, durationMs: Date.now() - startedAt, count: this.state.taskHistory.length }) }, history: () => this.state.taskHistory, show: (taskId) => this.taskTranscriptHydrator.show(taskId), delete: (taskIds) => this.taskHistoryCommands.delete(taskIds), deleteAll: () => this.taskHistoryCommands.deleteAll(), toggleFavorite: (taskId, isFavorited) => this.taskHistoryCommands.toggleFavorite(taskId, isFavorited), broadcast: () => this.broadcastState() })
		this.checkpointRpc = new CheckpointRpcHandler({ available: () => Boolean(this.clineSdk), checkpoints: () => this.requireCheckpoints(), currentTask: () => this.state.currentTaskItem, messages: () => this.state.clineMessages, workspaceRoot: () => this.getPrimaryWorkspaceRoot(), buildConfig: (cwd, sessionId) => this.sdkConfigBuilder.build(cwd, sessionId), toolPolicies: () => this.toolRuntimePolicy.currentPolicies(), showTask: (taskId) => this.taskTranscriptHydrator.show(taskId), addInfo: (text, checkpointRunCount) => { this.conversationMessages.add({ type: "say", say: "info", text, checkpointRunCount }) }, updateTask: () => this.taskState.update(), broadcast: () => this.broadcastState(), trackedChanges: () => this.requireChangeTracking().pendingChanges() })
		this.hookRpc = new HookRpcHandler({ hooks: () => this.requireHookSettings(), workspaceRoot: () => this.getPrimaryWorkspaceRoot(), enableHooks: () => { this.state.hooksEnabled = true } })
		this.scheduledAgentRpc = new ScheduledAgentRpcHandler({ agents: () => this.requireScheduledAgents(), workspaceRoot: () => this.getPrimaryWorkspaceRoot(), launch: async (request) => { await this.taskPrompts.start(request, { broadcast: false }) } })
		this.worktreeRpc = new WorktreeRpcHandler({ queries: () => this.requireWorktreeQueries(), mutations: () => this.requireWorktreeMutations(), workspaceRoot: () => this.getPrimaryWorkspaceRoot(), setFeatureEnabled: (enabled) => this.setWorktreesFeatureFlag(enabled) })
		this.mcpRpc = new McpRpcHandler({ mcp: () => this.requireMcp(), openSettings: (filePath) => this.host.windowClient.openFile({ filePath }), markRuntimeChanged: () => { this.runtimeSettingsRevision++ } })
		this.modelCatalogRpc = new ModelCatalogRpcHandler({ ollamaValues: (baseUrl) => this.requireProviderModelCatalogs().ollamaValues(baseUrl), lmStudioValues: (baseUrl) => this.requireProviderModelCatalogs().lmStudioValues(baseUrl), refresh: (providerId, request) => this.requireProviderModelCatalogs().refresh(providerId, request, asRecord(this.state.apiConfiguration), this.state.mode === "plan" ? "plan" : "act", this.modelContext.modelId()), askSage: (baseUrl) => this.requireProviderModelCatalogs().askSageModels(baseUrl), openRouterKeyInfo: (apiKey) => this.requireProviderModelCatalogs().openRouterKeyInfo(apiKey), unsupported: (key) => this.requireProviderModelCatalogs().unsupported(key) })
		this.fileRpc = new FileRpcHandler({ host: this.host, workspaceRoot: () => this.getPrimaryWorkspaceRoot(), resolvePath: (workspaceRoot, filePath) => path.isAbsolute(filePath) ? filePath : workspaceRoot ? path.resolve(workspaceRoot, filePath) : filePath, baseName: (filePath) => path.basename(filePath), exists: (filePath) => fs.existsSync(filePath), revert: (request) => this.requireChangeTracking().revert(request) })
		this.instructionSettingsRpc = new InstructionSettingsRpcHandler({ sdkSettings: () => this.requireSdkSettings(), workspaceRoot: () => this.getPrimaryWorkspaceRoot(), writeInstructions: ({ globalRules, localRules, globalWorkflows, localWorkflows }) => { this.state.globalClineRulesToggles = globalRules; this.state.localClineRulesToggles = localRules; this.state.globalWorkflowToggles = globalWorkflows; this.state.localWorkflowToggles = localWorkflows }, legacyRuleToggles: () => ({ cursor: this.state.localCursorRulesToggles, windsurf: this.state.localWindsurfRulesToggles, agents: this.state.localAgentsRulesToggles }), writeSkills: ({ global, local }) => { this.state.globalSkillsToggles = global; this.state.localSkillsToggles = local }, addError: (text) => { this.conversationMessages.add({ type: "say", say: "error", text }) } })
		this.uiWebRpc = new UiWebRpcHandler({ openExternal: (url) => this.host.envClient.openExternal({ value: url }), checkImage: (url) => checkIsImageUrl(url), openGraph: (url) => fetchOpenGraphData(url) })
		this.pluginRpc = new PluginRpcHandler({ workspaceRoot: () => this.getPrimaryWorkspaceRoot(), discover: (workspaceRoot) => discoverLocalPlugins(workspaceRoot) })
		this.unaryRpcRouter = new WebviewUnaryRpcRouter({ settings: this.settingsRpc, account: this.accountRpc, browser: this.browserRpc, terminal: this.terminalRpc, task: this.taskRpc, checkpoint: this.checkpointRpc, hook: this.hookRpc, scheduledAgent: this.scheduledAgentRpc, worktree: this.worktreeRpc, mcp: this.mcpRpc, modelCatalog: this.modelCatalogRpc, file: this.fileRpc, instructionSettings: this.instructionSettingsRpc, uiWeb: this.uiWebRpc, plugin: this.pluginRpc, stateMessages: () => this.buildStateMessages(), mcpStreamMessages: (payload) => this.buildMcpServerStreamMessages(payload) })
		this.stateStreamRefresh = new StateStreamRefreshCoordinator({ logger: this.logger, delayMs: () => readPositiveIntEnv("VSCLINE_STATE_REFRESH_DELAY_MS", 2500), shouldSkipScheduledRefresh: () => Boolean(this.state.currentTaskItem && this.clineSdk?.status.activeSessionId), refreshHistory: () => this.taskHistorySync.refresh(), refreshSelectedTask: () => this.taskTranscriptHydrator.refreshSelected(), broadcast: () => this.broadcastState(), formatError: (error) => stringify(error) })
		this.streamingRpc = new StreamingRpcHandler({ scheduleStateRefresh: () => this.stateStreamRefresh.schedule(), subscribeState: (requestId) => this.requireStreamPublisher().subscribeState(requestId), subscribePartial: (requestId) => { this.requireStreamPublisher().subscribePartial(requestId) }, unauthenticatedAccount: () => createUnauthenticatedAccountState(), mcpServers: async () => (await this.mcpRpc.handle({ type: "list" })).payload, mcpMarketplace: async () => (await this.mcpRpc.handle({ type: "marketplace" })).payload })
		this.streamingRpcRouter = new WebviewStreamingRpcRouter({ handler: this.streamingRpc, unsubscribeTransport: (requestId) => this.requireStreamPublisher().unsubscribe(requestId) })
		this.rpcIngress = new WebviewRpcIngress({
			logger: this.logger,
			streaming: this.streamingRpcRouter,
			unary: this.unaryRpcRouter,
			onUnaryError: async (error) => {
				this.conversationMessages.add({ type: "say", say: "error", text: error instanceof Error ? error.message : String(error) })
				this.taskState.update()
				await this.broadcastState()
			},
			slowRequestThresholdMs: () => readPositiveIntEnv("VSCLINE_SLOW_WEBVIEW_RPC_MS", 750),
		})
		this.taskTranscriptHydrator = new TaskTranscriptHydrator({
			isAvailable: () => Boolean(this.clineSdk && this.features.optional("taskSessions")),
			readCurrentTask: () => this.state.currentTaskItem,
			activeSessionId: () => this.clineSdk?.status.activeSessionId || "",
			hasLiveProjection: () => Boolean(this.conversationProjection.activePartialTextTs || this.conversationProjection.activeReasoningTextTs || this.conversationProjection.activeToolActivityTs),
			readMessages: () => this.state.clineMessages,
			loadTranscript: (taskId) => this.features.optional("taskSessions")?.load(taskId) ?? Promise.resolve(null),
			activateTranscript: (taskId) => this.features.require("taskSessions").activateAndRead(taskId),
			getSnapshot: (taskId) => this.taskState.getSnapshot(taskId),
			prepareActivation: (taskId) => { this.taskSession.prepareActivation(taskId) },
			clearLiveInteraction: (reason) => this.conversationCleanup.clearLiveInteraction(reason),
			projectSession: (session) => sdkSessionToHistoryItem(asRecord(session)),
			projectMessages: (messages, task) => sdkMessagesToClineMessages(messages, task),
			applySelected: (taskId, task, messages) => { this.state.currentTaskItem = task; this.state.clineMessages = messages; this.taskState.remember(taskId, task, messages); this.schedulePersistedStateSave() },
			applyShown: (taskId, task, messages) => { this.state.currentTaskItem = task; this.state.clineMessages = messages; this.taskState.remember(taskId, task, messages); this.stateStore.save(createPersistedStateSnapshot(this.state)) },
			applyCompleted: (taskId, task, messages) => { this.runtimeMonitoring.clearTaskActivity(); this.runtimeMonitoring.clearPartialIdle(); this.conversationActivity.clearReasoning(); this.conversationProjection.activePartialTextTs = null; this.conversationProjection.activeReasoningTextTs = null; this.conversationProjection.activeToolActivityTs = null; this.conversationProjection.activeAssistantTextBuffer = ""; this.state.currentTaskItem = task; this.state.clineMessages = messages; this.conversationCleanup.finalizeOpenPartials(); this.taskCompletion.addMarker("completed"); this.taskState.update(); this.taskState.remember(taskId, task, this.state.clineMessages); this.schedulePersistedStateSave() },
			summarizeMessage: (message) => summarizeClineMessageForLog(message),
			log: (event, details) => this.logger.log("sidecar", event, details),
			broadcast: () => this.broadcastState(),
			isSessionNotFound: (error) => isSessionNotFoundError(error),
		})
		this.partialTextProjector = new PartialTextProjector(this.conversationProjection, () => this.state.clineMessages, () => this.conversationMessages.nextTimestamp(), (timestamp, updates) => this.conversationMessages.upsert(timestamp, updates), (message) => this.sendPartialMessage(message), () => this.runtimeMonitoring.schedulePartialIdle(), () => this.runtimeMonitoring.clearPartialIdle(), () => this.runtimeMonitoring.clearPartialBroadcast(), () => this.runtimeMonitoring.broadcastPartialNow(), () => this.runtimeMonitoring.schedulePartialBroadcast())
		this.foldedProgressProjector = new FoldedProgressProjector(this.conversationProjection, () => this.state.clineMessages, () => this.conversationMessages.nextTimestamp(), (timestamp, updates) => this.conversationMessages.upsert(timestamp, updates), (message) => this.sendPartialMessage(message), () => this.runtimeMonitoring.broadcastPartialNow(), () => this.runtimeMonitoring.schedulePartialBroadcast(), () => this.features.optional("terminalActivity")?.stop(), () => this.getUiLanguage())
		this.conversationRuntime = new ConversationRuntimeProjector({ projection: this.conversationProjection, messages: () => this.state.clineMessages, messageStore: this.conversationMessages, partial: this.partialTextProjector, folded: this.foldedProgressProjector, language: () => this.getUiLanguage(), currentSessionId: () => this.taskSession.currentSessionId, markFirstAssistant: (sessionId, textLength) => this.runtimeMonitoring.markFirstAssistant(sessionId, textLength), schedulePartialIdle: () => this.runtimeMonitoring.schedulePartialIdle(), schedulePartialBroadcast: () => this.runtimeMonitoring.schedulePartialBroadcast(), addMessage: (message) => { this.conversationMessages.add(message) }, publishPartial: (message) => this.sendPartialMessage(message) })
		this.conversationCleanup = new ConversationCleanupCoordinator({ projection: this.conversationProjection, messages: this.conversationMessages, partial: this.partialTextProjector, folded: this.foldedProgressProjector, runtime: this.conversationRuntime, monitoring: this.runtimeMonitoring, terminalActive: () => this.features.optional("terminalActivity")?.isActive === true, stopTerminal: () => { this.features.optional("terminalActivity")?.stop() }, hasPendingApproval: () => this.approvals.hasPending, hasPendingQuestion: () => Boolean(this.pendingQuestion), clearApproval: (reason) => { this.approvals.clear({ approved: false, reason }) }, clearQuestion: () => { this.pendingQuestion?.resolve(""); this.pendingQuestion = null }, logger: this.logger })
		this.conversationActivity = new ConversationActivityProjector({ projection: this.conversationProjection, hasCurrentTask: () => Boolean(this.state.currentTaskItem), reasoningStatusIntervalMs: () => readPositiveIntEnv("VSCLINE_REASONING_STATUS_INTERVAL_MS", 2000), logger: this.logger })
		this.taskCompletion = new TaskCompletionProjector({ messages: () => this.state.clineMessages, transition: (status, source) => { this.taskSession.transition(status, source) }, clearFinishStatus: () => { this.runtimeMonitoring.clearTaskActivity(); this.runtimeMonitoring.clearPartialIdle(); this.conversationActivity.clearReasoning() }, finishProgress: () => { this.conversationCleanup.finishProgress() }, prepareAssistant: () => { this.conversationCleanup.prepareAssistant() }, activeText: () => this.partialTextProjector.activeText(), addMessage: (message) => { this.conversationMessages.add(message) }, markAssistantLatency: (length) => this.runtimeMonitoring.markFirstAssistant(this.taskSession.currentSessionId, length), finalizeOpenPartial: () => this.conversationCleanup.finalizeOpenPartials(), lastActivityReason: () => this.features.optional("taskActivity")?.reason || "", runCompleteHook: (context) => { void this.hookLifecycle.run("TaskComplete", context) }, persist: () => this.stateStore.save(createPersistedStateSnapshot(this.state)), language: () => this.getUiLanguage(), recentToolSummaries: () => this.conversationProjection.recentToolSummaries(5), log: (event, details) => this.logger.log("sidecar", event, details) })
		this.runtimeStatusEvents = new RuntimeStatusEventProjector({ shouldIgnore: (sessionId) => this.taskSession.shouldIgnoreEvent(sessionId), markFirstEvent: (sessionId, eventType) => this.runtimeMonitoring.markFirstSdkEvent(sessionId, eventType), activeText: () => this.partialTextProjector.activeText(), finishTask: (sessionId, status, text) => this.taskCompletion.finish(sessionId, status, text), updateTask: () => this.taskState.update(), broadcast: () => { this.broadcastState().catch((error) => console.error(error)) }, transitionStreaming: (source) => { this.taskSession.transition("streaming", source) }, noteActivity: (reason) => this.runtimeMonitoring.noteActivity(reason), schedulePartial: () => this.runtimeMonitoring.schedulePartialBroadcast(), log: (event, details) => this.logger.log("sidecar", event, details) })
		const runtimeEvents = new AgentRuntimeEventDispatcher({ transitionStreaming: (source) => { this.taskSession.transition("streaming", source) }, shouldIgnore: (sessionId) => this.taskSession.shouldIgnoreEvent(sessionId), markFirstEvent: (sessionId, eventType) => this.runtimeMonitoring.markFirstSdkEvent(sessionId, eventType), projectAgent: (event, sessionId) => this.semanticEvents.handle(event, sessionId), trackWorkspaceChange: (change) => { try { this.requireChangeTracking().track(change) } catch (error) { console.error(error) } }, projectChunk: (event) => this.agentChunkEvents.handle(event), projectSnapshot: (event) => this.agentSnapshotEvents.handle(event), projectAuxiliary: (event) => this.agentAuxiliaryEvents.handle(event), projectLifecycle: (event) => this.runtimeStatusEvents.handle(event), log: (event, details) => this.logger.log("sidecar", event, details), activeSessionId: () => this.clineSdk?.status.activeSessionId || "", currentTaskId: () => String(this.state.currentTaskItem?.id || "") })
		this.runtimeEventIngress = new WebviewRuntimeEventIngress(this.logger, runtimeEvents, (sessionId) => this.runtimeMonitoring.correlationId(sessionId))
		this.agentTextEvents = new AgentTextEventProjector({ noteActivity: (reason) => this.runtimeMonitoring.noteActivity(reason), clearReasoning: () => this.conversationActivity.clearReasoning(), recordReasoning: (text) => this.conversationActivity.recordReasoning(text), foldReasoning: (text) => this.foldedProgressProjector.upsertReasoning(text), upsertAssistant: (accumulated, delta) => this.conversationRuntime.upsertAssistant(accumulated, delta), completeAssistant: (text) => this.conversationRuntime.completeAssistant(text), activeAssistantText: () => this.conversationProjection.activeAssistantTextBuffer })
		this.agentToolEvents = new AgentToolEventProjector({ noteActivity: (reason) => this.runtimeMonitoring.noteActivity(reason), clearReasoning: () => this.conversationActivity.clearReasoning(), clearPartial: () => { this.runtimeMonitoring.clearPartialIdle(); this.conversationProjection.activePartialTextTs = null }, recordActivity: (tool, text) => this.conversationRuntime.recordToolActivity(tool, text), startTerminal: () => this.requireTerminalActivity().start(), stopTerminal: () => this.features.optional("terminalActivity")?.stop(), finalPollTerminal: () => { this.requireTerminalActivity().poll().catch((error) => this.logger.log("sidecar", "terminalStateFinalPollFailed", { message: stringify(error) })) }, postToolUse: (event) => { void this.hookLifecycle.run("PostToolUse", { sessionId: event.sessionId, toolName: event.toolName, input: event.input, output: event.output, error: event.error, iteration: event.iteration }) }, handleBrowser: (tool, input, error) => { void this.browserToolEvents.execute(tool, input, error) }, shouldSuppressTrackedEdit: (tool, path) => (tool === "editor" || tool === "edit") && (this.requireChangeTracking().hasRecentlyTrackedChange() || Boolean(path && this.requireChangeTracking().wasRecentlyTracked(path))), rememberSummary: (tool, text) => this.conversationActivity.rememberToolSummary(tool, text), appendTerminal: (text) => this.foldedProgressProjector.appendTerminal(text), moveProgressToEnd: () => this.foldedProgressProjector.moveActiveToEnd(), language: () => this.getUiLanguage() })
		this.agentLifecycleEvents = new AgentLifecycleEventProjector({ noteActivity: (reason) => this.runtimeMonitoring.noteActivity(reason), clearReasoning: () => this.conversationActivity.clearReasoning(), finishToolActivity: () => this.conversationRuntime.finishToolActivity(), finishProgress: () => this.foldedProgressProjector.finish(), finalizePartial: () => this.partialTextProjector.finalize(), addText: (text) => this.conversationMessages.add({ type: "say", say: "text", text }), addError: (text) => this.conversationMessages.add({ type: "say", say: "error", text }), finishTask: (sessionId, status, text) => this.taskCompletion.finish(sessionId, status, text), updateUsage: (usage) => this.taskState.update(usage), recordContextUsage: (usage) => this.conversationMessages.add({ type: "say", say: "api_req_started", text: JSON.stringify({ request: "", tokensIn: usage.tokensIn || 0, tokensOut: usage.tokensOut || 0, cacheReads: usage.cacheReads || 0, cacheWrites: usage.cacheWrites || 0, cost: usage.totalCost || 0, usageReliable: true }), partial: false, isCollapsed: true, isExpanded: false }), hasCompletion: () => this.taskCompletion.hasCompletionAfterLastUser(), activePartialText: () => this.partialTextProjector.activeText(), hasAssistantAfterUser: () => this.taskCompletion.hasAssistantAfterLastUser(), log: (event, details) => this.logger.log("sidecar", event, details), formatError: (error) => formatProviderErrorForTranscript(error, this.getUiLanguage()), markErrorLatency: (sessionId, error) => this.runtimeMonitoring.markError(sessionId, error) })
		this.semanticEvents = new AgentEventDispatcher({ bindSession: (sessionId) => this.taskSession.bindSession(sessionId), projectText: (event) => this.agentTextEvents.handle(event), projectTool: (event) => this.agentToolEvents.handle(event), projectLifecycle: (event) => this.agentLifecycleEvents.handle(event), updateTask: () => this.taskState.update(), broadcast: () => { this.broadcastState().catch((error) => console.error(error)) } })
		this.agentAuxiliaryEvents = new AgentAuxiliaryEventProjector({ noteActivity: (reason) => this.runtimeMonitoring.noteActivity(reason), addMessage: (message) => { this.conversationMessages.add(message) }, updateTask: () => this.taskState.update(), broadcast: () => { this.broadcastState().catch((error) => console.error(error)) }, log: (event, details) => this.logger.log("sidecar", event, details) })
		this.agentSnapshotEvents = new AgentSnapshotEventProjector({ bindSession: (sessionId) => this.taskSession.bindSession(sessionId), finishTask: (sessionId, status, text) => this.taskCompletion.finish(sessionId, status, text), noteActivity: (reason) => this.runtimeMonitoring.noteActivity(reason), activeText: () => this.partialTextProjector.activeText(), updateTask: (updates) => this.taskState.update(updates), broadcast: () => { this.broadcastState().catch((error) => console.error(error)) } })
		this.agentChunkEvents = new AgentChunkEventProjector({ noteActivity: (reason) => this.runtimeMonitoring.noteActivity(reason), noteQuietActivity: (reason) => this.runtimeMonitoring.noteQuietActivity(reason), finishTask: (status, text) => this.taskCompletion.finish(this.clineSdk?.status.activeSessionId || String(this.state.currentTaskItem?.id || ""), status, text), addMessage: (message) => { this.conversationMessages.add(message) }, recordTool: (text) => this.conversationRuntime.recordToolActivity("tool", text), foldReasoning: (text) => this.foldedProgressProjector.upsertReasoning(text), updateTask: () => this.taskState.update(), broadcast: () => { this.broadcastState().catch((error) => console.error(error)) }, schedulePartial: () => this.runtimeMonitoring.schedulePartialBroadcast(), recentTexts: () => this.state.clineMessages.slice(-3).map((message) => getString(message, "text")), commandOutputLimit: () => readPositiveIntEnv("VSCLINE_COMMAND_OUTPUT_CHARS", 12000), agentTranscriptLimit: () => readPositiveIntEnv("VSCLINE_AGENT_TRANSCRIPT_CHARS", 12000), logSkipped: (chunk) => this.logger.log("sidecar", "sdkAgentChunkSkippedForUi", summarizeAgentChunkForLog(chunk)) })
		this.taskSession.initialize(this.state.currentTaskItem ? "completed" : "idle")
	}

	attachFeature<K extends keyof WebviewFeatures>(key: K, value: WebviewFeatures[K]) { this.features.attach(key, value) }
	attachStreamPublisher(value: WebviewFeatures["streamPublisher"]) { value.setCorrelationIdProvider(() => this.activeCorrelationId()); this.features.attach("streamPublisher", value) }

	// Transitional facade alias. Feature slices should receive AgentEnginePort
	// directly as they are extracted from this legacy backend.
	private get clineSdk() {
		return this.features.optional("agentEngine")
	}

	serializeState() { return JSON.stringify(this.state) }
	activeCorrelationId() {
		const sessionId = this.taskSession.currentSessionId || this.clineSdk?.status.activeSessionId || String(this.state.currentTaskItem?.id || "")
		return sessionId ? this.runtimeMonitoring.correlationId(sessionId) : ""
	}
	async publishChangeTranscript(text: string) { this.conversationMessages.add({ type: "say", say: "tool", text }); this.taskState.update(); await this.broadcastState() }
	updateTerminalActivity(text: string) { this.conversationProjection.activeTerminalActivityText = text; this.foldedProgressProjector.refresh(); this.taskState.update() }
	hasActiveTask() { return Boolean(this.state.currentTaskItem) }
	hasActivePartialText() { return Boolean(this.conversationProjection.activePartialTextTs) }
	handleTaskIdleLongRunning() { this.taskState.update(); this.broadcastState().catch((error) => console.error(error)) }
	hasStateSubscribers() { return this.features.optional("streamPublisher")?.hasStateSubscribers === true }
	getActivePartialSnapshot() { const message = this.state.clineMessages.find((item) => item.ts === this.conversationProjection.activePartialTextTs); const text = getString(message, "text"); return this.conversationProjection.activePartialTextTs && text.trim() ? { textLength: text.length } : null }
	handlePartialIdle() { this.taskState.update(); this.broadcastState().catch((error) => console.error(error)) }
	requestStateBroadcast() { this.broadcastState().catch((error) => console.error(error)) }

	dispose() {
		this.runtimeMonitoring.clearAll()
		this.features.optional("terminalActivity")?.dispose()
		this.features.optional("changeTracking")?.dispose()
		this.features.optional("streamPublisher")?.dispose()
		this.streamingRpcRouter.clear()
		this.stateStreamRefresh.dispose()
		this.approvals.clear({ approved: false, reason: "LIG VS webview router was disposed." })
		this.pendingQuestion?.resolve("")
		this.pendingQuestion = null
		this.flushPersistedStateSave()
		this.features.optional("oauthAuthorization")?.dispose()
	}

	isScheduledAgentsEnabled() {
		return this.state.scheduledAgentsEnabled === true || process.env.VSCLINE_ENABLE_AUTOMATION === "1"
	}

	async requestToolApproval(request: ApprovalRequestedEvent): Promise<ToolApprovalResult> {
		return this.toolApproval.execute(request)
	}

	async requestQuestion(question: string, options: string[]): Promise<AskQuestionResult> {
		this.taskSession.transition("awaiting_user", "question")
		this.taskSession.waitFor("question")
		this.logger.log("sdk->sidecar", "question.request", { question, options })
		if (this.pendingQuestion) {
			this.pendingQuestion.resolve("")
			this.pendingQuestion = null
		}
		this.conversationMessages.removeAsks("followup")

		this.conversationMessages.add({
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
		this.runtimeEventIngress.handle(event)
	}

	async handle(envelope: WebviewEnvelope) {
		return this.rpcIngress.handle(envelope)
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
		return this.features.require("agentEngine")
	}

	private requireMcp() {
		return this.features.require("mcp")
	}

	private buildMcpServerStreamMessages(response: unknown) {
		return this.streamingRpcRouter.mcpMessages(response)
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
		return this.features.require("browser")
	}

	private requireWorktreeQueries() {
		return this.features.require("worktreeQueries")
	}

	private requireWorktreeMutations() {
		return this.features.require("worktreeMutations")
	}

	private requireOAuthAuthorization() {
		return this.features.require("oauthAuthorization")
	}

	private requireOAuthCallbackHandler() {
		return this.features.require("oauthCallback")
	}

	private requireProviderCredentials() {
		return this.features.require("providerCredentials")
	}

	private requireProviderAuthActions() {
		return this.features.require("providerAuthActions")
	}

	private requireScheduledAgents() {
		return this.features.require("scheduledAgents")
	}

	private requireHookSettings() {
		return this.features.require("hookSettings")
	}

	private requireHookExecution() {
		return this.features.require("hookExecution")
	}

	private requireCheckpoints() {
		return this.features.require("checkpoints")
	}

	private requireTerminalActivity() {
		return this.features.require("terminalActivity")
	}

	private requireTaskActivity() {
		return this.features.require("taskActivity")
	}

	private requirePartialStateScheduler() {
		return this.features.require("partialState")
	}

	private requireSendLatency() {
		return this.features.require("sendLatency")
	}

	private requireChangeTracking() {
		return this.features.require("changeTracking")
	}

	private requireProviderModelCatalogs() {
		return this.features.require("providerModelCatalogs")
	}

	private requireStreamPublisher() {
		return this.features.require("streamPublisher")
	}

	private requireSdkSettings() {
		return this.features.require("sdkSettings")
	}

	getUiLanguage(): "en" | "ko" {
		return getString(this.state, "uiLanguage") === "en" ? "en" : "ko"
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

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function readPositiveIntEnv(name: string, fallback: number) {
	const raw = process.env[name]
	if (!raw) {
		return fallback
	}

	const value = Number.parseInt(raw, 10)
	return Number.isFinite(value) && value > 0 ? value : fallback
}
