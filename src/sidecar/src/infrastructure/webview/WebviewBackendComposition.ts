import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
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
	createPersistedStateSnapshot,
	createWebviewStateSnapshot,
	loadInitialState,
} from "./WebviewState"
import type { AgentRuntimeEvent } from "../../domain/agent/AgentRuntimeEvent"
import type { ApprovalRequestedEvent } from "../../domain/agent/AgentRuntimeEvent"
import { isAgentRunActive } from "../../domain/task/TaskLifecycle"
import type { BrowserSettings } from "../../features/browser/BrowserHandler"
import { ApprovalCoordinator } from "../../features/approvals/ApprovalCoordinator"
import { ToolApprovalFlow } from "../../features/approvals/ToolApprovalFlow"
import { rebindTaskHistoryId, upsertTaskHistoryItem } from "../../features/taskHistory/TaskHistoryCollection"
import {
	checkIsImageUrl,
	fetchOpenGraphData,
} from "../browser/BrowserDevToolsAdapter"
import { BrowserToolEventFlow } from "../../features/browser/BrowserToolEventFlow"
import {
	discoverLocalPlugins,
} from "../persistence/LocalAutomationStore"
import { ConversationProjectionState } from "../../features/conversation/ConversationProjectionState"
import { WebviewStreamPublisher } from "./WebviewStreamPublisher"
import { WebviewFeatureRegistry, type RuntimeWebviewFeatures } from "./WebviewFeatureRegistry"
import { TaskSnapshotStore } from "../../features/taskHistory/TaskSnapshotStore"
import { TaskStateCoordinator } from "../../features/taskHistory/TaskStateCoordinator"
import type { TaskHistorySync } from "../../features/taskHistory/TaskHistorySync"
import type { TaskHistoryCommands } from "../../features/taskHistory/TaskHistoryCommands"
import { TaskTranscriptHydrator } from "../../features/taskHistory/TaskTranscriptHydrator"
import { TaskCompletionProjector } from "../conversation/TaskCompletionProjector"
import { RuntimeMonitoringCoordinator } from "../../features/runtime/RuntimeMonitoringCoordinator"
import { TaskSessionCoordinator } from "../../features/runtime/TaskSessionCoordinator"
import { createTaskCancellationComposition, type CancelTaskWork } from "./TaskCancellationComposition"
import { ConversationMessageStore } from "../conversation/ConversationMessageStore"
import { ApiConfigurationProfileManager } from "../configuration/ApiConfigurationProfileManager"
import { resolveUsableWorkingDirectory } from "../sdk/SdkEnvironment"
import { SettingsMutationHandler } from "../configuration/SettingsMutationHandler"
import { ToolRuntimePolicy } from "../configuration/ToolRuntimePolicy"
import { LocalFileInteractionAdapter } from "../files/LocalFileInteractionAdapter"
import { createWebviewFeatureHandlers } from "./WebviewFeatureHandlerComposition"
import { StateStreamRefreshCoordinator } from "../../features/web/StateStreamRefreshCoordinator"
import { summarizeClineMessageForLog } from "./WebviewInteractionLogSupport"
import { formatEmptyModelResponseForUi, formatSdkErrorForUi, isSessionNotFoundError, stringify } from "./RuntimeErrorFormatter"
import { WebviewRpcIngress } from "./WebviewRpcIngress"
import { WebviewStreamingRpcRouter } from "./WebviewStreamingRpcRouter"
import { createWebviewRpcComposition } from "./WebviewRpcComposition"
import type { WebviewRuntimeEventIngress } from "./WebviewRuntimeEventIngress"
import { createAgentEventProjectionComposition } from "./AgentEventProjectionComposition"
import { AgentSdkConfigBuilder, createConnectionUpdate } from "../configuration/AgentSdkConfigBuilder"
import { resolveEffectiveModelId } from "../models/EffectiveModelResolver"
import { RuntimeModelContext } from "../models/RuntimeModelContext"
import { AutoApprovalNotifier } from "../notifications/AutoApprovalNotifier"
import { buildTaskInputWithAttachments, normalizeSdkImageInputs } from "../conversation/AttachmentNormalization"
import { createHistoryItem, createId, sdkSessionToHistoryItem } from "../conversation/TaskHistoryProjection"
import { createTaskHistoryComposition } from "./TaskHistoryComposition"
import { extractCompletionTextFromResult } from "../conversation/CompletionExtraction"
import { PartialTextProjector } from "../conversation/PartialTextProjector"
import { FoldedProgressProjector } from "../conversation/FoldedProgressProjector"
import { ConversationRuntimeProjector } from "../conversation/ConversationRuntimeProjector"
import { ConversationCleanupCoordinator } from "../conversation/ConversationCleanupCoordinator"
import { ToolApprovalPromptProjector } from "../conversation/ToolApprovalPromptProjector"
import { ConversationActivityProjector } from "../conversation/ConversationActivityProjector"
import type { CompactionNotice } from "../conversation/AgentLifecycleEventProjector"
import { HookLifecycleCoordinator } from "../../features/hooks/HookLifecycleCoordinator"
import {
	buildResumedConversationContext,
} from "../conversation/ResumedConversationProjection"
import {
	shouldAutoApproveTool,
	mapToolName,
} from "../conversation/ToolCommandFormatting"
import {
	sdkMessagesToClineMessages,
} from "../conversation/SdkMessageTranscriptProjection"
import {
	normalizeApiConfiguration,
	isWebFetchEnabled,
	webFetchDisabledReason,
} from "../configuration/ProviderConfiguration"
import * as ChatFlows from "./WebviewChatFlows"
import { asRecord, getString, readPositiveIntEnv, sdkStatusToTaskLifecycle } from "./WebviewBackendValues"
import { RUNTIME_DEFAULTS } from "../configuration/RuntimeEnvironment"

export class WebviewBackendComposition implements WebviewApplicationPort {
	private readonly features = new WebviewFeatureRegistry()
	private readonly activeCompactionBudgets = new Map<string, Pick<CompactionNotice, "maxInputTokens" | "triggerTokens" | "targetTokens" | "messageTargetTokens">>()
	private readonly clearTaskHandler: ChatFlows.ClearTaskHandler
	private readonly cancelTaskFlow: ChatFlows.CancelTaskFlow
	private readonly agentRunRecovery: ChatFlows.AgentRunRecoveryFlow
	private readonly agentRunCompletion: ChatFlows.AgentRunCompletionFlow
	private readonly sendOrResumeSession: ChatFlows.SendOrResumeSessionFlow
	private readonly resumeSession: ChatFlows.ResumeSessionFlow
	private readonly launchAgentSession: ChatFlows.LaunchAgentSessionFlow
	private readonly prepareNewTask: ChatFlows.PrepareNewTaskFlow
	private readonly startNewTaskFlow: ChatFlows.StartNewTaskFlow
	private readonly askResponseInteractions: ChatFlows.AskResponseInteractionFlow
	private readonly sendUserMessage: ChatFlows.SendUserMessageFlow
	private readonly taskPrompts: ChatFlows.TaskPromptFlow
	private readonly state: ReturnType<typeof createInitialState>
	private readonly approvals = new ApprovalCoordinator()
	private pendingQuestion:
		| {
				resolve: (value: AskQuestionResult) => void
				reject: (error: Error) => void
				dispose: () => void
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
	private readonly taskCompletion: TaskCompletionProjector
	private readonly runtimeEventIngress: WebviewRuntimeEventIngress
	private readonly runtimeMonitoring: RuntimeMonitoringCoordinator
	private readonly taskSession: TaskSessionCoordinator
	private readonly cancelTaskWork: CancelTaskWork
	private readonly apiConfigurationProfiles: ApiConfigurationProfileManager
	private readonly settingsMutations: SettingsMutationHandler
	private readonly toolRuntimePolicy: ToolRuntimePolicy
	private readonly browserToolEvents: BrowserToolEventFlow
	private readonly streamingRpcRouter: WebviewStreamingRpcRouter
	private readonly rpcIngress: WebviewRpcIngress
	private readonly stateStreamRefresh: StateStreamRefreshCoordinator
	private readonly sdkConfigBuilder: AgentSdkConfigBuilder
	private readonly modelContext: RuntimeModelContext
	private readonly autoApprovalNotifier: AutoApprovalNotifier
	private readonly hookLifecycle: HookLifecycleCoordinator
	private sdkRunGeneration = 0
	private runtimeSettingsRevision = 0
	private activeSessionRuntimeSettingsRevision = 0
	private connectionSettingsRevision = 0
	private activeSessionConnectionSettingsRevision = 0

	constructor(
		private readonly host: HostProviderPort,
		private readonly transport: WebviewTransportPort,
		private readonly logger: InteractionLoggerPort,
		private readonly stateStore: StatePersistenceUseCase,
		private readonly taskLifecycle: TaskLifecycleUseCase,
	) {
		this.state = loadInitialState(this.stateStore.load())
		this.features.attach("streamPublisher", new WebviewStreamPublisher(this.transport, this.logger, () => this.serializeState(), () => this.activeCorrelationId(), () => String(this.state.currentTaskItem?.id || this.taskSession.currentSessionId || "")))
		this.modelContext = new RuntimeModelContext({ configuration: () => asRecord(this.state.apiConfiguration), mode: () => this.state.mode === "plan" ? "plan" : "act", defaultModelId: () => process.env.CLINE_MODEL_ID || "", defaultOllamaModelId: () => process.env.OLLAMA_MODEL || process.env.CLINE_MODEL_ID || "" })
		this.autoApprovalNotifier = new AutoApprovalNotifier(this.host.windowClient, this.logger)
		this.toolRuntimePolicy = new ToolRuntimePolicy({ autoApprovalSettings: () => this.state.autoApprovalSettings, browserSettings: () => this.state.browserSettings, mode: () => this.state.mode === "plan" ? "plan" : "act", strictPlanModeEnabled: () => this.state.strictPlanModeEnabled === true, yoloMode: () => this.state.yoloModeToggled === true, writeWebToolState: (state) => { this.state.clineWebToolsEnabled = state as typeof this.state.clineWebToolsEnabled }, logger: this.logger })
		this.taskSnapshots = new TaskSnapshotStore(this.state.taskSnapshots, (snapshots) => { this.state.taskSnapshots = snapshots })
		this.taskState = new TaskStateCoordinator({ snapshots: this.taskSnapshots, readCurrentTask: () => this.state.currentTaskItem, writeCurrentTask: (task) => { this.state.currentTaskItem = task }, readMessages: () => this.state.clineMessages, readHistory: () => this.state.taskHistory, writeHistory: (history) => { this.state.taskHistory = history }, schedulePersist: () => this.schedulePersistedStateSave() })
		this.runtimeMonitoring = new RuntimeMonitoringCoordinator({
			taskActivity: () => this.features.require("taskActivity"),
			optionalTaskActivity: () => this.features.optional("taskActivity"),
			partialState: () => this.features.require("partialState"),
			optionalPartialState: () => this.features.optional("partialState"),
			sendLatency: () => this.features.require("sendLatency"),
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
		this.toolApproval = new ToolApprovalFlow({ mapToolName: (toolName) => mapToolName(toolName), isPlanModeBlocked: (mappedToolName) => this.toolRuntimePolicy.isBlockedInCurrentMode(mappedToolName), blockedReason: () => this.toolApprovalPrompts.blockedReason(this.getUiLanguage()), addInfo: (text) => { this.conversationMessages.add({ type: "say", say: "info", text }) }, currentSessionId: () => this.taskSession.currentSessionId, preToolUse: (context) => this.hookLifecycle.preToolUse(context), shouldAutoApprove: (toolName) => shouldAutoApproveTool(toolName, this.state.autoApprovalSettings, this.state.yoloModeToggled === true), notifyAutoApproved: (mappedToolName, input) => this.autoApprovalNotifier.notify(asRecord(this.state.autoApprovalSettings).enableNotifications === true, mappedToolName, input), buildPrompt: (mappedToolName, input, approvalRequest) => this.toolApprovalPrompts.build(mappedToolName, input, approvalRequest), beginApproval: () => { this.taskSession.transition("awaiting_user", "tool-approval"); this.taskSession.waitFor("tool_approval") }, addAsk: ({ ask, text }) => { this.conversationMessages.add({ type: "ask", ask, text }) }, updateTask: () => this.taskState.update(), broadcast: () => this.broadcastState(), requestApproval: () => this.approvals.request(), logRequest: (details) => this.logger.log("sdk->sidecar", "toolApproval.request", details), log: (event, details) => this.logger.log("sidecar", event, details) })
		this.conversationMessages = new ConversationMessageStore({ read: () => this.state.clineMessages, write: (messages) => { this.state.clineMessages = messages }, persist: () => this.schedulePersistedStateSave(), publishPartial: (message) => this.sendPartialMessage(message), log: (event, details) => this.logger.log("sidecar", event, details) })
		this.hookLifecycle = new HookLifecycleCoordinator({ execution: () => this.features.require("hookExecution"), workspaceRoot: () => this.getPrimaryWorkspaceRoot(), enabled: () => this.state.hooksEnabled !== false, addMessage: (message) => this.conversationMessages.add(message), nextTimestamp: () => this.conversationMessages.nextTimestamp(), upsertMessage: (timestamp, updates) => this.conversationMessages.upsert(timestamp, updates), updateTask: () => this.taskState.update(), broadcast: () => this.broadcastState().catch((error) => { console.error(error) }) })
		this.cancelTaskWork = createTaskCancellationComposition({ abortAgent: async (sessionId) => { const handler = this.features.optional("cancelTask"); if (!handler) throw new Error("Agent cancellation handler is unavailable."); await handler.execute({ sessionId }) }, cancelTerminal: async () => { await this.host.workspaceClient.cancelCommands() }, cancelHooks: async () => { const execution = this.features.optional("hookExecution"); if (execution) await execution.cancelAll() }, cancelBrowser: async () => { const browser = this.features.optional("browser"); if (browser) await browser.cancelActive() }, cancelInteraction: async () => { this.approvals.clear({ approved: false, reason: "Task cancellation requested." }); this.settlePendingQuestion("", createAbortError("Question was cancelled with the active task.")) }, timeoutMs: () => readPositiveIntEnv("VSCLINE_TASK_CANCEL_TIMEOUT_MS", RUNTIME_DEFAULTS.taskCancelTimeoutMs), log: (event, details) => this.logger.log("sidecar", event, details) })
		this.clearTaskHandler = new ChatFlows.ClearTaskHandler(() => this.clineSdk, { transition: (status, source) => this.taskSession.transition(status, source), currentStatus: () => this.taskSession.status, advanceRunGeneration: () => { this.sdkRunGeneration++ }, currentSessionId: () => this.taskSession.currentSessionId, isClosing: (sessionId) => this.taskSession.isClosing(sessionId), markClosing: (sessionId, closing = true) => { this.taskSession.markClosing(sessionId, closing) }, cancelWork: (sessionId) => this.cancelTaskWork(sessionId), rememberSnapshot: () => { this.taskState.capture() }, clearProjection: () => { this.conversationCleanup.clearProjection() }, clearInteractions: () => { this.approvals.clear({ approved: false, reason: "Task was closed." }); this.settlePendingQuestion("") }, clearTaskState: () => { this.state.currentTaskItem = null; this.state.clineMessages = [] }, resetLifecycle: (source) => { this.taskSession.reset(source) }, persist: () => this.schedulePersistedStateSave(), broadcast: () => this.broadcastState(), log: (event, details) => this.logger.log("sidecar", event, details) })
		this.cancelTaskFlow = new ChatFlows.CancelTaskFlow({ beginCancel: () => Boolean(this.taskSession.transition("cancelling", "cancel-request")), currentStatus: () => this.taskSession.status, advanceRunGeneration: () => { this.sdkRunGeneration++ }, hookSessionId: () => this.taskSession.currentSessionId, activeSessionId: () => this.taskSession.currentSessionId, cancelWork: (sessionId) => this.cancelTaskWork(sessionId), clearProjection: () => { this.conversationCleanup.clearProjection(); this.conversationCleanup.finalizeOpenPartials(); this.conversationMessages.removeTerminalAsks() }, addCancellationMarker: () => { this.taskCompletion.addMarker("cancelled") }, addError: (text) => { this.conversationMessages.add({ type: "say", say: "error", text }) }, updateTask: () => this.taskState.capture(), runHook: (sessionId) => this.hookLifecycle.run("TaskCancel", { sessionId }), completeCancel: () => { this.taskSession.transition("idle", "cancel-complete") }, failCancellation: () => { this.taskSession.transition("failed", "cancel-failed") }, quarantineSession: (sessionId) => { this.taskSession.markClosing(sessionId) }, broadcast: () => this.broadcastState(), log: (event, details) => this.logger.log("sidecar", event, details) })
		this.agentRunRecovery = new ChatFlows.AgentRunRecoveryFlow({ currentGeneration: () => this.sdkRunGeneration, isTerminal: () => this.taskSession.status === "completed" || this.taskSession.status === "failed", activeText: () => this.partialTextProjector.activeText(), hasAssistantText: () => this.taskCompletion.hasAssistantAfterLastUser(), hydrate: (sessionId, source) => this.taskTranscriptHydrator.hydrateCurrent(sessionId, source, true), sessionStatus: async (sessionId) => sdkSessionStatus(await this.clineSdk?.getSession({ sessionId })), finishTask: (sessionId, status, text) => this.taskCompletion.finish(sessionId, status, text), updateTask: () => this.taskState.update(), broadcast: () => this.broadcastState(), projectFailure: (source, error) => { this.runtimeMonitoring.clearTaskActivity(); this.taskSession.transition("failed", `sdk-error:${source}`); this.runtimeMonitoring.clearPartialIdle(); this.conversationActivity.clearReasoning(); this.conversationMessages.add({ type: "say", say: "error", text: formatSdkErrorForUi(error, this.getUiLanguage()) }) }, log: (event, details) => this.logger.log("sidecar", event, details) })
		this.agentRunCompletion = new ChatFlows.AgentRunCompletionFlow({ decode: (result, fallbackSessionId) => { const resultRecord = asRecord(result); const agentResult = asRecord(resultRecord.result ?? result); return { sessionId: getString(resultRecord, "sessionId") || fallbackSessionId || String(this.state.currentTaskItem?.id || ""), empty: Object.keys(agentResult).length === 0, text: extractCompletionTextFromResult(agentResult, resultRecord), finishReason: getString(agentResult, "finishReason") || getString(agentResult, "status") || "completed" } }, currentGeneration: () => this.sdkRunGeneration, currentTaskId: () => String(this.state.currentTaskItem?.id || ""), activeSessionId: () => this.taskSession.currentSessionId, bindSession: (sessionId) => this.taskSession.bindSession(sessionId), isCurrentSession: (sessionId) => this.taskSession.isCurrentResult(sessionId), hydrate: (sessionId, source) => this.taskTranscriptHydrator.hydrateCurrent(sessionId, source, true), activeText: () => this.partialTextProjector.activeText(), hasAssistantText: () => this.taskCompletion.hasAssistantAfterLastUser(), lastActivityReason: () => this.features.optional("taskActivity")?.reason || "", finishTask: (sessionId, status, text) => this.taskCompletion.finish(sessionId, status, text), failEmpty: (sessionId) => this.taskCompletion.fail(sessionId, formatEmptyModelResponseForUi(this.getUiLanguage())), finalizePartial: () => this.conversationCleanup.finalizeOpenPartials(), addCompletionMarker: (status) => this.taskCompletion.addMarker(status), updateTask: () => this.taskState.update(), broadcast: () => this.broadcastState(), log: (event, details) => this.logger.log("sidecar", event, details) })
		this.sendOrResumeSession = new ChatFlows.SendOrResumeSessionFlow(() => this.clineSdk, {
			activeSettingsRevision: () => this.activeSessionRuntimeSettingsRevision,
			settingsRevision: () => this.runtimeSettingsRevision,
			activeConnectionRevision: () => this.activeSessionConnectionSettingsRevision,
			connectionRevision: () => this.connectionSettingsRevision,
			syncConnection: async (sessionId) => {
				const cwd = String(this.state.currentTaskItem?.cwdOnTaskInitialization || this.getPrimaryWorkspaceRoot())
				const config = await this.sdkConfigBuilder.build(cwd, sessionId)
				await this.features.require("agentEngine").updateConnection(createConnectionUpdate(sessionId, config))
			},
			markConnectionRevisionActive: () => { this.activeSessionConnectionSettingsRevision = this.connectionSettingsRevision },
			requiresReplacement: (sessionId) => this.taskSession.isClosing(sessionId),
			bindSession: (sessionId) => this.taskSession.bindSession(sessionId),
			markClosing: (sessionId, closing) => { if (closing) this.taskSession.markClosing(sessionId); else this.taskSession.prepareActivation(sessionId) },
			send: (command) => this.features.require("sendMessage").execute(command),
			resume: (sessionId, command, textLength) => this.resumeSession.execute(sessionId, command, textLength),
			markSend: (sessionId) => this.runtimeMonitoring.markSdkSend(sessionId),
			markError: (sessionId, error) => this.runtimeMonitoring.markError(sessionId, error),
			isSessionNotFound: (error) => isSessionNotFoundError(error),
			log: (event, details) => this.logger.log("sidecar", event, details),
		})
		this.resumeSession = new ChatFlows.ResumeSessionFlow({ isRuntimeAvailable: () => Boolean(this.clineSdk), workspaceRoots: () => this.host.workspaceClient.getWorkspacePaths({}), currentCwd: () => String(this.state.currentTaskItem?.cwdOnTaskInitialization || ""), prepareTask: (sessionId, prompt, cwd) => { const taskItem = this.state.currentTaskItem || createHistoryItem(sessionId, prompt, cwd, this.modelContext.modelId()); this.state.currentTaskItem = { ...taskItem, id: sessionId, cwdOnTaskInitialization: cwd, modelId: String(taskItem.modelId || "") || this.modelContext.modelId() }; this.state.taskHistory = upsertTaskHistoryItem(this.state.taskHistory, this.state.currentTaskItem); return { title: String(taskItem.task || "").trim() } }, noteActivity: (reason) => this.runtimeMonitoring.noteActivity(reason), updateTask: () => this.taskState.update(), broadcast: () => this.broadcastState(), runResumeHook: (context) => { void this.hookLifecycle.run("TaskResume", context) }, buildContext: (prompt) => buildResumedConversationContext(this.state.clineMessages, prompt, this.modelContext.resumedConversationTokenBudget()), normalizeImages: (images) => normalizeSdkImageInputs([...images]), buildConfig: (cwd) => this.sdkConfigBuilder.build(cwd), toolPolicies: () => this.toolRuntimePolicy.currentPolicies(), start: (command) => this.features.require("startTask").execute(command), beginReplacement: (sessionId) => { this.taskSession.beginReplacement(sessionId); this.runtimeEventIngress.beginReplacement(sessionId) }, completeReplacement: (result) => { const sessionId = getString(asRecord(result), "sessionId") || this.clineSdk?.status.activeSessionId || ""; this.taskSession.completeReplacement(sessionId); this.runtimeEventIngress.completeReplacement(sessionId) }, cancelReplacement: () => { this.runtimeEventIngress.cancelReplacement(); this.taskSession.cancelReplacement() }, markSettingsRevisionActive: () => { this.activeSessionRuntimeSettingsRevision = this.runtimeSettingsRevision; this.activeSessionConnectionSettingsRevision = this.connectionSettingsRevision }, log: (event, details) => this.logger.log("sidecar", event, details) })
		this.launchAgentSession = new ChatFlows.LaunchAgentSessionFlow({ isRuntimeAvailable: () => Boolean(this.clineSdk), buildConfig: (cwd, sessionId) => this.sdkConfigBuilder.build(cwd, sessionId), toolPolicies: () => this.toolRuntimePolicy.currentPolicies(), markSend: (sessionId) => this.runtimeMonitoring.markSdkSend(sessionId), nextGeneration: () => ++this.sdkRunGeneration, currentGeneration: () => this.sdkRunGeneration, start: (command) => this.features.require("startTask").execute(command), markSettingsRevisionActive: () => { this.activeSessionRuntimeSettingsRevision = this.runtimeSettingsRevision; this.activeSessionConnectionSettingsRevision = this.connectionSettingsRevision }, complete: (result, sessionId, source, generation) => this.agentRunCompletion.complete(result, sessionId, source, generation), recover: (sessionId, source, generation, error) => this.agentRunRecovery.recover(sessionId, source, generation, error), log: (event, details) => this.logger.log("sidecar", event, details) })
		this.prepareNewTask = new ChatFlows.PrepareNewTaskFlow({ isRuntimeAvailable: () => Boolean(this.clineSdk), workspaceRoots: () => this.host.workspaceClient.getWorkspacePaths({}), resolveWorkspacePath: (requestedPath) => requestedPath && fs.existsSync(requestedPath) ? path.resolve(requestedPath) : null, updateTask: () => this.taskState.update(), publishPreparing: () => this.sendPartialMessage(this.state.clineMessages.find((message) => message.ts === this.conversationProjection.activeReasoningTextTs)), activeSessionId: () => this.taskSession.currentSessionId, markClosing: (sessionId, closing = true) => { this.taskSession.markClosing(sessionId, closing) }, stopSession: (sessionId) => this.features.require("agentEngine").stop({ sessionId }), runHook: (name, context) => { void this.hookLifecycle.run(name, context) }, normalizeImages: (images) => normalizeSdkImageInputs(images), launch: (params, cwd, sessionId) => this.launchAgentSession.execute(params, cwd, sessionId, "startSession"), projectError: async (error) => { this.runtimeMonitoring.clearTaskActivity(); this.foldedProgressProjector.finish(); this.taskSession.transition("failed", "start-task-error"); this.conversationMessages.add({ type: "say", say: "error", text: error instanceof Error ? error.message : String(error) }); this.taskState.update(); await this.broadcastState() }, log: (event, details) => this.logger.log("sidecar", event, details) })
		this.startNewTaskFlow = new ChatFlows.StartNewTaskFlow({ isRuntimeAvailable: () => Boolean(this.clineSdk), stopPrevious: () => this.prepareNewTask.stopPrevious(), transitionStarting: () => { this.taskSession.transition("starting", "start-new-task") }, createTask: (input) => createHistoryItem(createId(), input.text, input.initialCwd, this.modelContext.modelId()), startLatency: (requestId, taskId, textLength) => this.runtimeMonitoring.startLatency(requestId, "newTask", taskId, textLength), beginConversation: () => { this.state.clineMessages = []; this.conversationProjection.beginTask() }, selectTask: (task) => { this.state.currentTaskItem = task; this.state.taskHistory = upsertTaskHistoryItem(this.state.taskHistory, task) }, addUserTask: (text, images, files) => { this.conversationMessages.add({ type: "say", say: "task", text, images, files }) }, showPreparing: () => this.foldedProgressProjector.upsertReasoning(this.state.uiLanguage === "en" ? "Preparing response." : "응답을 준비하는 중입니다."), noteActivity: (reason) => this.runtimeMonitoring.noteActivity(reason), updateTask: () => this.taskState.capture(), persist: () => this.schedulePersistedStateSave(), broadcast: () => { this.broadcastState().catch((error) => console.error(error)) }, prepare: (input, task) => this.prepareNewTask.execute({ text: input.text, images: input.images, files: input.files, requestedWorkspacePath: input.requestedWorkspacePath, initialCwd: input.initialCwd, taskItem: task }), fail: (error) => this.prepareNewTask.reportError(error) })
		this.askResponseInteractions = new ChatFlows.AskResponseInteractionFlow({ hasPendingApproval: () => this.approvals.hasPending, hasPendingQuestion: () => Boolean(this.pendingQuestion), takeApproval: () => this.approvals.take() ?? undefined, takeQuestion: () => this.pendingQuestion ? (value) => this.settlePendingQuestion(value) : undefined, transitionStreaming: (source) => { this.taskSession.transition("streaming", source) }, noteActivity: (reason) => this.runtimeMonitoring.noteActivity(reason), removeFollowup: () => this.conversationMessages.removeAsks("followup"), addFeedback: (text, images, files) => { this.conversationMessages.add({ type: "say", say: "user_feedback", text, images, files }) }, updateTask: () => this.taskState.update(), broadcast: () => this.broadcastState(), log: (event, details) => this.logger.log("sidecar", event, details) })
		this.sendUserMessage = new ChatFlows.SendUserMessageFlow({
			interactions: {
				hasPending: () => this.approvals.hasPending || Boolean(this.pendingQuestion),
				clear: () => { this.approvals.clear({ approved: false, reason: "Superseded by resumed chat message." }); this.settlePendingQuestion("") },
			},
			newTask: { start: (input) => this.taskPrompts.start({ text: input.prompt, images: input.images, files: input.files }, { broadcast: true, requestId: input.requestId }) },
			lifecycle: {
				startLatency: (requestId, sessionId, textLength) => this.runtimeMonitoring.startLatency(requestId, "askResponse", sessionId, textLength),
				transitionStarting: () => { this.taskSession.transition("starting", "send-response") },
				nextGeneration: () => ++this.sdkRunGeneration,
				currentGeneration: () => this.sdkRunGeneration,
			},
			projection: {
				addUserMessage: (text, images, files) => { this.conversationMessages.removeTerminalAsks(); this.conversationMessages.removeAsks("followup"); const message = this.conversationMessages.add({ type: "say", say: "user_feedback", text, images, files }); this.foldedProgressProjector.beginReasoning(); return message },
				showPreparing: () => this.foldedProgressProjector.upsertReasoning(this.state.uiLanguage === "en" ? "Preparing response." : "응답을 준비하는 중입니다."),
				persist: () => this.schedulePersistedStateSave(),
				publishPartial: (message) => this.sendPartialMessage(message !== null && typeof message === "object" && !Array.isArray(message) ? message as Record<string, unknown> : undefined),
				broadcast: () => { this.broadcastState().catch((error) => console.error(error)) },
			},
			attachments: { normalizeImages: (images) => normalizeSdkImageInputs(images) },
			hooks: { onPrompt: (context) => { void this.hookLifecycle.run("UserPromptSubmit", context) } },
			agent: {
				send: (sessionId, command, textLength) => this.sendOrResumeSession.execute(sessionId, command, textLength),
				resultSessionId: (result, fallback) => getString(asRecord(result), "sessionId") || fallback,
				complete: (result, sessionId, generation) => this.agentRunCompletion.complete(result, sessionId, "send", generation),
				recover: (sessionId, generation, error) => this.agentRunRecovery.recover(sessionId, "send", generation, error),
			},
			log: (event, details) => this.logger.log("sidecar", event, details),
		})
		this.taskPrompts = new ChatFlows.TaskPromptFlow({ startFlow: this.startNewTaskFlow, interactionFlow: this.askResponseInteractions, sendFlow: this.sendUserMessage, isRuntimeAvailable: () => Boolean(this.clineSdk), activeSessionId: () => this.taskSession.currentSessionId, selectedSessionId: () => String(this.state.currentTaskItem?.id || ""), mode: () => this.state.mode === "plan" ? "plan" : "act", hasPendingApproval: () => this.approvals.hasPending, hasPendingQuestion: () => Boolean(this.pendingQuestion), resolveInitialCwd: async (requestedWorkspacePath) => { const roots = await this.host.workspaceClient.getWorkspacePaths({}).catch(() => []); return resolveUsableWorkingDirectory([requestedWorkspacePath && fs.existsSync(requestedWorkspacePath) ? path.resolve(requestedWorkspacePath) : undefined, ...roots, String(this.state.currentTaskItem?.cwdOnTaskInitialization || "")]) }, buildTranscript: (text, images, files) => buildTaskInputWithAttachments(text, images, files), createRequestId: () => createId(), log: (event, details) => this.logger.log("sidecar", event, details) })
		this.apiConfigurationProfiles = new ApiConfigurationProfileManager({ readConfiguration: () => asRecord(this.state.apiConfiguration), writeConfiguration: (configuration) => { this.state.apiConfiguration = configuration as typeof this.state.apiConfiguration }, readProfiles: () => this.state.apiConfigurationProfiles, writeProfiles: (profiles) => { this.state.apiConfigurationProfiles = profiles }, readActiveId: () => this.state.activeApiConfigurationProfileId, writeActiveId: (profileId) => { this.state.activeApiConfigurationProfileId = profileId }, readSeparateModels: () => this.state.planActSeparateModelsSetting, writeSeparateModels: (enabled) => { this.state.planActSeparateModelsSetting = enabled } })
		this.settingsMutations = new SettingsMutationHandler({
			state: () => this.state as unknown as Record<string, unknown>,
			profiles: this.apiConfigurationProfiles,
			refreshWebTools: () => this.toolRuntimePolicy.refreshWebToolState(),
			connectionChanged: () => {
				this.connectionSettingsRevision++
				this.logger.log("sidecar", "connectionSettingsChanged", { connectionSettingsRevision: this.connectionSettingsRevision, activeSessionConnectionSettingsRevision: this.activeSessionConnectionSettingsRevision })
			},
			runtimeChanged: () => {
				this.runtimeSettingsRevision++
				this.logger.log("sidecar", "runtimeSettingsChanged", { runtimeSettingsRevision: this.runtimeSettingsRevision, activeSessionRuntimeSettingsRevision: this.activeSessionRuntimeSettingsRevision })
			},
		})
		this.browserToolEvents = new BrowserToolEventFlow({ browser: () => this.features.require("browser"), settings: () => this.getBrowserSettings(), addMessage: (message) => { this.conversationMessages.add(message) }, updateTask: () => this.taskState.update(), broadcast: () => this.broadcastState() })
		this.sdkConfigBuilder = new AgentSdkConfigBuilder({ state: () => this.state as unknown as Record<string, unknown>, resolveModelId: (configuration, providerId, modePrefix, baseUrl) => resolveEffectiveModelId(configuration, providerId, modePrefix, baseUrl, (modelId) => this.applyDefaultOllamaModel(modelId)), log: (event, details) => this.logger.log("sidecar", event, details) })
		const history = createTaskHistoryComposition({
			runtime: () => this.clineSdk,
			history: () => this.state.taskHistory,
			writeHistory: (items) => { this.state.taskHistory = items },
			currentTask: () => this.state.currentTaskItem,
			writeCurrentTask: (task) => { this.state.currentTaskItem = task },
			clearMessages: () => { this.state.clineMessages = [] },
			clearLiveInteraction: (reason) => this.conversationCleanup.clearLiveInteraction(reason),
			taskState: this.taskState,
			persist: () => this.schedulePersistedStateSave(),
			broadcast: () => this.broadcastState(),
			log: (event, details) => this.logger.log("sidecar", event, details),
		})
		this.taskHistorySync = history.sync
		this.taskHistoryCommands = history.commands
		const handlers = createWebviewFeatureHandlers({
			settings: { state: () => this.state as unknown as Record<string, unknown>, applySettings: (settings) => this.settingsMutations.apply(settings), persist: () => this.flushPersistedStateSave(), broadcast: () => this.broadcastState(), clearPersistedState: () => this.stateStore.clear(), resetState: () => { Object.assign(this.state, createInitialState()) }, clearTask: () => this.clearTaskHandler.execute() },
			account: { authorization: () => this.features.require("oauthAuthorization"), callback: () => this.features.require("oauthCallback"), authActions: () => this.features.require("providerAuthActions"), credentials: () => this.features.require("providerCredentials"), configuration: () => asRecord(this.state.apiConfiguration), mutateConfiguration: (updates, deletes) => { const next = { ...asRecord(this.state.apiConfiguration), ...updates }; for (const field of deletes) delete next[field]; this.state.apiConfiguration = normalizeApiConfiguration(next) as typeof this.state.apiConfiguration }, syncProfiles: () => this.apiConfigurationProfiles.syncActive(), setCodexAuthenticated: (authenticated) => { this.state.openAiCodexIsAuthenticated = authenticated }, persist: () => this.schedulePersistedStateSave(), broadcast: () => this.broadcastState(), log: (event, details) => this.logger.log("sidecar", event, details) },
			browser: { browser: () => this.features.require("browser"), settings: () => this.getBrowserSettings() },
			terminal: this.host.workspaceClient,
			task: { hasPendingQuestion: () => Boolean(this.pendingQuestion), hasCurrentTask: () => Boolean(this.state.currentTaskItem), isStarting: () => this.taskSession.status === "starting", start: (request, requestId) => this.taskPrompts.start(request, { broadcast: true, requestId }), respond: (request, requestId) => this.taskPrompts.respond(request, requestId), compact: async (requestId) => { if (this.state.useAutoCondense !== true) { this.state.useAutoCondense = true; this.runtimeSettingsRevision++; await this.flushPersistedStateSave() } this.logger.log("sidecar", "legacyManualCompactionRedirected", { requestId, sdkAutoCompactionEnabled: true }); await this.broadcastState() }, cancel: () => this.cancelTaskFlow.execute(), clear: () => this.clearTaskHandler.execute(), refreshHistory: async (source) => { const startedAt = Date.now(); await this.taskHistorySync.refresh(); this.logger.log("sidecar", "stateHydration.historyRefreshed", { source, durationMs: Date.now() - startedAt, count: this.state.taskHistory.length }) }, history: () => this.state.taskHistory, currentWorkspace: () => this.getPrimaryWorkspaceRoot(), show: (taskId) => this.taskTranscriptHydrator.show(taskId), delete: (taskIds) => this.taskHistoryCommands.delete(taskIds), deleteAll: () => this.taskHistoryCommands.deleteAll(), toggleFavorite: (taskId, isFavorited) => this.taskHistoryCommands.toggleFavorite(taskId, isFavorited), broadcast: () => this.broadcastState(), operationHistoryLimit: () => readPositiveIntEnv("VSCLINE_TASK_OPERATION_HISTORY", RUNTIME_DEFAULTS.taskOperationHistoryEntries) },
			checkpoint: { available: () => Boolean(this.clineSdk), checkpoints: () => this.features.require("checkpoints"), currentTask: () => this.state.currentTaskItem, messages: () => this.state.clineMessages, workspaceRoot: () => this.getPrimaryWorkspaceRoot(), buildConfig: (cwd, sessionId) => this.sdkConfigBuilder.build(cwd, sessionId), toolPolicies: () => this.toolRuntimePolicy.currentPolicies(), showTask: (taskId) => this.taskTranscriptHydrator.show(taskId), addInfo: (text, checkpointRunCount) => { this.conversationMessages.add({ type: "say", say: "info", text, checkpointRunCount }) }, updateTask: () => this.taskState.update(), broadcast: () => this.broadcastState(), trackedChanges: () => this.features.require("changeTracking").pendingChanges() },
			hook: { hooks: () => this.features.require("hookSettings"), workspaceRoot: () => this.getPrimaryWorkspaceRoot(), enableHooks: () => { this.state.hooksEnabled = true } },
			scheduledAgent: { agents: () => this.features.require("scheduledAgents"), workspaceRoot: () => this.getPrimaryWorkspaceRoot(), launch: async (request) => { await this.taskPrompts.start(request, { broadcast: false }) } },
			worktree: { queries: () => this.features.require("worktreeQueries"), mutations: () => this.features.require("worktreeMutations"), workspaceRoot: () => this.getPrimaryWorkspaceRoot(), setFeatureEnabled: (enabled) => this.setWorktreesFeatureFlag(enabled) },
			mcp: { mcp: () => this.features.require("mcp"), openSettings: (filePath) => this.host.windowClient.openFile({ filePath }), markRuntimeChanged: () => { this.runtimeSettingsRevision++ } },
			modelCatalog: { ollamaValues: (baseUrl, signal) => this.features.require("providerModelCatalogs").ollamaValues(baseUrl, signal), lmStudioValues: (baseUrl, signal) => this.features.require("providerModelCatalogs").lmStudioValues(baseUrl, signal), refresh: (providerId, request, signal) => this.features.require("providerModelCatalogs").refresh(providerId, request, asRecord(this.state.apiConfiguration), this.state.mode === "plan" ? "plan" : "act", this.modelContext.modelId(), signal), askSage: (baseUrl, signal) => this.features.require("providerModelCatalogs").askSageModels(baseUrl, signal), openRouterKeyInfo: (apiKey, signal) => this.features.require("providerModelCatalogs").openRouterKeyInfo(apiKey, signal), unsupported: (key) => this.features.require("providerModelCatalogs").unsupported(key) },
			file: {
				host: this.host,
				interactions: new LocalFileInteractionAdapter(this.host),
				workspaceRoot: () => this.getPrimaryWorkspaceRoot(),
				resolvePath: (workspaceRoot, filePath) => path.isAbsolute(filePath) ? filePath : workspaceRoot ? path.resolve(workspaceRoot, filePath) : filePath,
				baseName: (filePath) => path.basename(filePath),
				exists: (filePath) => fs.existsSync(filePath),
				revert: (request) => this.features.require("changeTracking").revert(request),
				toFilePath: (uri) => uri.startsWith("file:") ? fileURLToPath(uri) : path.resolve(uri),
				relativePath: (root, target) => path.relative(root, target),
				isPathInside: (root, target) => { const relative = path.relative(root, target); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) },
				searchCommits: (workspaceRoot) => this.features.require("worktreeQueries").runGit(["log", "--all", "-n", "100", "--date=short", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%ad"], workspaceRoot),
				conversationHistory: (taskId) => {
					const currentId = String(this.state.currentTaskItem?.id || "")
					const snapshot = this.taskState.getSnapshot(taskId)
					return snapshot || (taskId === currentId ? { taskItem: this.state.currentTaskItem, messages: this.state.clineMessages } : { taskId, messages: [] })
				},
				focusChain: (taskId) => {
					const currentId = String(this.state.currentTaskItem?.id || "")
					const snapshot = this.taskState.getSnapshot(taskId)
					const messages = snapshot?.messages || (taskId === currentId ? this.state.clineMessages : [])
					return [...messages].reverse().find((message) => getString(message, "say") === "task_progress")?.text as string || ""
				},
			},
			instructionSettings: { sdkSettings: () => this.features.require("sdkSettings"), workspaceRoot: () => this.getPrimaryWorkspaceRoot(), writeInstructions: ({ globalRules, localRules, globalWorkflows, localWorkflows }) => { this.state.globalClineRulesToggles = globalRules; this.state.localClineRulesToggles = localRules; this.state.globalWorkflowToggles = globalWorkflows; this.state.localWorkflowToggles = localWorkflows }, legacyRuleToggles: () => ({ cursor: this.state.localCursorRulesToggles, windsurf: this.state.localWindsurfRulesToggles, agents: this.state.localAgentsRulesToggles }), writeSkills: ({ global, local }) => { this.state.globalSkillsToggles = global; this.state.localSkillsToggles = local }, addError: (text) => { this.conversationMessages.add({ type: "say", say: "error", text }) } },
			uiWeb: { openExternal: (url) => this.host.envClient.openExternal({ value: url }), checkImage: (url) => checkIsImageUrl(url), openGraph: (url) => fetchOpenGraphData(url) },
			plugin: { workspaceRoot: () => this.getPrimaryWorkspaceRoot(), discover: (workspaceRoot) => discoverLocalPlugins(workspaceRoot) },
		})
		this.stateStreamRefresh = new StateStreamRefreshCoordinator({ logger: this.logger, delayMs: () => readPositiveIntEnv("VSCLINE_STATE_REFRESH_DELAY_MS", 2500), shouldSkipScheduledRefresh: () => (this.features.optional("taskActivity")?.idleForMs ?? Number.POSITIVE_INFINITY) < readPositiveIntEnv("VSCLINE_STATE_REFRESH_QUIET_MS", 5000), shouldContinueScheduledRefresh: () => Boolean(this.state.currentTaskItem && this.clineSdk?.status.activeSessionId && this.hasStateSubscribers() && ["starting", "streaming", "awaiting_user"].includes(this.taskSession.status)), historyRefreshIntervalMs: () => readPositiveIntEnv("VSCLINE_HISTORY_REFRESH_INTERVAL_MS", 30000), refreshHistory: () => this.taskHistorySync.refresh(), refreshSelectedTask: () => this.taskTranscriptHydrator.refreshSelected(), broadcast: () => this.broadcastState(), formatError: (error) => stringify(error) })
		const rpc = createWebviewRpcComposition({
			logger: this.logger,
			handlers,
			scheduleStateRefresh: () => this.stateStreamRefresh.schedule(),
			subscribeState: (requestId) => this.features.require("streamPublisher").subscribeState(requestId),
			subscribePartial: (requestId) => this.features.require("streamPublisher").subscribePartial(requestId),
			unsubscribe: (requestId) => this.features.require("streamPublisher").unsubscribe(requestId),
			stateMessages: () => this.buildStateMessages(),
			mcpStreamMessages: (payload) => this.buildMcpServerStreamMessages(payload),
			onUnaryError: async (error) => {
				this.conversationMessages.add({ type: "say", say: "error", text: error instanceof Error ? error.message : String(error) })
				this.taskState.update()
				await this.broadcastState()
			},
			slowRequestThresholdMs: () => readPositiveIntEnv("VSCLINE_SLOW_WEBVIEW_RPC_MS", 750),
		})
		this.streamingRpcRouter = rpc.streaming
		this.rpcIngress = rpc.ingress
		this.taskTranscriptHydrator = new TaskTranscriptHydrator({
			isAvailable: () => Boolean(this.clineSdk && this.features.optional("taskSessions")),
			readCurrentTask: () => this.state.currentTaskItem,
			activeSessionId: () => this.taskSession.currentSessionId,
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
			applyShown: (taskId, task, messages) => { this.state.currentTaskItem = task; this.state.clineMessages = messages; this.taskState.remember(taskId, task, messages); this.schedulePersistedStateSave() },
			applyHydrated: (taskId, task, messages) => { this.state.currentTaskItem = task; this.state.clineMessages = messages; this.taskState.update(); this.taskState.remember(taskId, task, this.state.clineMessages); this.schedulePersistedStateSave() },
			reconcileSession: (taskId, status, source) => {
				const lifecycle = sdkStatusToTaskLifecycle(status)
				if (lifecycle) this.taskSession.reconcile(lifecycle, taskId, source)
			},
			summarizeMessage: (message) => summarizeClineMessageForLog(message),
			log: (event, details) => this.logger.log("sidecar", event, details),
			broadcast: () => this.broadcastState(),
			isSessionNotFound: (error) => isSessionNotFoundError(error),
		})
		this.partialTextProjector = new PartialTextProjector(this.conversationProjection, () => this.state.clineMessages, () => this.conversationMessages.nextTimestamp(), (timestamp, updates) => this.conversationMessages.upsert(timestamp, updates), (message) => this.sendPartialMessage(message), () => this.runtimeMonitoring.schedulePartialIdle(), () => this.runtimeMonitoring.clearPartialIdle(), () => this.runtimeMonitoring.clearPartialBroadcast(), () => this.runtimeMonitoring.broadcastPartialNow(), () => this.runtimeMonitoring.schedulePartialBroadcast())
		this.foldedProgressProjector = new FoldedProgressProjector(this.conversationProjection, () => this.state.clineMessages, () => this.conversationMessages.nextTimestamp(), (timestamp, updates) => this.conversationMessages.upsert(timestamp, updates), (message) => this.sendPartialMessage(message), () => this.runtimeMonitoring.broadcastPartialNow(), () => this.runtimeMonitoring.schedulePartialBroadcast(), () => this.features.optional("terminalActivity")?.stop(), () => this.getUiLanguage())
		this.conversationRuntime = new ConversationRuntimeProjector({ projection: this.conversationProjection, messages: () => this.state.clineMessages, messageStore: this.conversationMessages, partial: this.partialTextProjector, folded: this.foldedProgressProjector, language: () => this.getUiLanguage(), currentSessionId: () => this.taskSession.currentSessionId, markFirstAssistant: (sessionId, textLength) => this.runtimeMonitoring.markFirstAssistant(sessionId, textLength), schedulePartialIdle: () => this.runtimeMonitoring.schedulePartialIdle(), schedulePartialBroadcast: () => this.runtimeMonitoring.schedulePartialBroadcast(), addMessage: (message) => { this.conversationMessages.add(message) }, publishPartial: (message) => this.sendPartialMessage(message) })
		this.conversationCleanup = new ConversationCleanupCoordinator({ projection: this.conversationProjection, messages: this.conversationMessages, partial: this.partialTextProjector, folded: this.foldedProgressProjector, runtime: this.conversationRuntime, monitoring: this.runtimeMonitoring, terminalActive: () => this.features.optional("terminalActivity")?.isActive === true, stopTerminal: () => { this.features.optional("terminalActivity")?.stop() }, hasPendingApproval: () => this.approvals.hasPending, hasPendingQuestion: () => Boolean(this.pendingQuestion), clearApproval: (reason) => { this.approvals.clear({ approved: false, reason }) }, clearQuestion: () => { this.settlePendingQuestion("") }, logger: this.logger })
		this.conversationActivity = new ConversationActivityProjector({ projection: this.conversationProjection, hasCurrentTask: () => Boolean(this.state.currentTaskItem), reasoningStatusIntervalMs: () => readPositiveIntEnv("VSCLINE_REASONING_STATUS_INTERVAL_MS", 2000), logger: this.logger })
		this.taskCompletion = new TaskCompletionProjector({ messages: () => this.state.clineMessages, transition: (status, source) => { this.taskSession.transition(status, source) }, clearFinishStatus: () => { this.runtimeMonitoring.clearTaskActivity(); this.runtimeMonitoring.clearPartialIdle(); this.conversationActivity.clearReasoning() }, finishProgress: () => { this.conversationCleanup.finishProgress() }, prepareAssistant: () => { this.conversationCleanup.prepareAssistant() }, activeText: () => this.partialTextProjector.activeText(), addMessage: (message) => { this.conversationMessages.add(message) }, markAssistantLatency: (length) => this.runtimeMonitoring.markFirstAssistant(this.taskSession.currentSessionId, length), finalizeOpenPartial: () => this.conversationCleanup.finalizeOpenPartials(), lastActivityReason: () => this.features.optional("taskActivity")?.reason || "", runCompleteHook: (context) => { void this.hookLifecycle.run("TaskComplete", context) }, capture: () => this.taskState.capture(), persist: () => this.schedulePersistedStateSave(), language: () => this.getUiLanguage(), recentToolSummaries: () => this.conversationProjection.recentToolSummaries(5), log: (event, details) => this.logger.log("sidecar", event, details) })
		this.runtimeEventIngress = createAgentEventProjectionComposition({
			logger: this.logger,
			monitoring: this.runtimeMonitoring,
			session: this.taskSession,
			activity: this.conversationActivity,
			folded: this.foldedProgressProjector,
			runtime: this.conversationRuntime,
			projection: this.conversationProjection,
			partial: this.partialTextProjector,
			completion: this.taskCompletion,
			messages: this.conversationMessages,
			taskState: this.taskState,
			hooks: this.hookLifecycle,
			browserTools: this.browserToolEvents,
			startTerminal: () => this.features.require("terminalActivity").start(),
			stopTerminal: () => this.features.optional("terminalActivity")?.stop(),
			pollTerminal: () => this.features.require("terminalActivity").poll(),
			shouldSuppressTrackedEdit: (tool, trackedPath) =>
				(tool === "editor" || tool === "edit") &&
				(this.features.require("changeTracking").hasRecentlyTrackedChange() || Boolean(trackedPath && this.features.require("changeTracking").wasRecentlyTracked(trackedPath))),
			trackWorkspaceChange: (change) => {
				try { this.features.require("changeTracking").track(change) } catch (error) { console.error(error) }
			},
			activeSessionId: () => this.taskSession.currentSessionId,
			currentTaskId: () => String(this.state.currentTaskItem?.id || ""),
			language: () => this.getUiLanguage(),
			recentTexts: () => this.state.clineMessages.slice(-3).map((message) => getString(message, "text")),
			setCompactionStatus: (notice) => this.applyCompactionNotice(notice),
			broadcast: () => this.broadcastState(),
		})
		this.taskSession.initialize(this.state.currentTaskItem ? "completed" : "idle")
	}

	configureFeatures(features: RuntimeWebviewFeatures) { this.features.complete(features) }

	// Transitional facade alias. Feature slices should receive AgentEnginePort
	// directly as they are extracted from this legacy backend.
	private get clineSdk() {
		return this.features.optional("agentEngine")
	}

	serializeState() { return JSON.stringify(createWebviewStateSnapshot(this.state)) }
	activeCorrelationId() {
		const sessionId = this.taskSession.currentSessionId || this.clineSdk?.status.activeSessionId || String(this.state.currentTaskItem?.id || "")
		return sessionId ? this.runtimeMonitoring.correlationId(sessionId) : ""
	}
	async publishChangeTranscript(text: string) { this.conversationMessages.add({ type: "say", say: "tool", text }); this.taskState.update(); await this.broadcastState() }
	updateTerminalActivity(text: string) { this.conversationProjection.activeTerminalActivityText = text; this.foldedProgressProjector.refresh(); this.taskState.update() }
	hasActiveAgentRun() {
		return Boolean(this.state.currentTaskItem)
			&& isAgentRunActive(this.taskSession.status)
	}
	hasActivePartialText() { return Boolean(this.conversationProjection.activePartialTextTs) }
	handleTaskIdleWaiting(idleForMs: number, reason: string) {
		if (!this.hasActiveAgentRun() || this.hasActivePartialText()) return
		this.foldedProgressProjector.upsertReasoning(this.state.uiLanguage === "en"
			? "Waiting for the model or API provider to return its first response."
			: "모델 또는 API 제공자의 첫 응답을 기다리는 중입니다.")
		this.logger.log("sidecar", "taskWaitingProjected", { idleForMs, reason })
		this.taskState.update()
		this.broadcastState().catch((error) => console.error(error))
	}
	handleTaskIdleLongRunning() { this.taskState.update(); this.broadcastState().catch((error) => console.error(error)) }

	private applyCompactionNotice(notice: CompactionNotice) {
		this.state.contextCompactionInProgress = notice.phase === "started"
		if (notice.phase === "idle") {
			if (notice.sessionId) this.activeCompactionBudgets.delete(notice.sessionId)
			else this.activeCompactionBudgets.clear()
			return
		}
		this.foldedProgressProjector.beginReasoning()
		if (notice.phase === "started") {
			this.activeCompactionBudgets.set(notice.sessionId, {
				maxInputTokens: notice.maxInputTokens,
				triggerTokens: notice.triggerTokens,
				targetTokens: notice.targetTokens,
				messageTargetTokens: notice.messageTargetTokens,
			})
			this.foldedProgressProjector.upsertReasoning(this.getUiLanguage() === "en"
				? "The Cline SDK is compacting the current context."
				: "Cline SDK가 현재 컨텍스트를 압축하는 중입니다.")
			return
		}
		if (notice.phase === "skipped") {
			this.activeCompactionBudgets.delete(notice.sessionId)
			this.foldedProgressProjector.upsertReasoning(this.getUiLanguage() === "en"
				? "Automatic compaction found no context that could be reduced, so the response is continuing without compaction."
				: "현재 대화에서 줄일 수 있는 컨텍스트가 없어 자동 압축을 건너뛰고 응답을 계속합니다.")
			return
		}

		this.foldedProgressProjector.upsertReasoning(this.getUiLanguage() === "en"
			? "Context compacted. Preparing the response."
			: "컨텍스트 압축이 완료되었습니다. 응답을 준비하는 중입니다.")
		const startedBudget = this.activeCompactionBudgets.get(notice.sessionId)
		this.activeCompactionBudgets.delete(notice.sessionId)
		const timestamp = this.conversationProjection.activeReasoningTextTs
		if (!timestamp) return
		const maxInputTokens = notice.maxInputTokens ?? startedBudget?.maxInputTokens
		const triggerTokens = notice.triggerTokens ?? startedBudget?.triggerTokens
		const targetTokens = notice.targetTokens ?? startedBudget?.targetTokens
		const messageTargetTokens = notice.messageTargetTokens ?? startedBudget?.messageTargetTokens
		this.conversationMessages.upsert(timestamp, {
			contextCompaction: {
				sourceSessionId: notice.sessionId,
				sessionId: notice.sessionId,
				...(notice.messagesBefore !== undefined ? { messagesBefore: notice.messagesBefore } : {}),
				...(notice.messagesAfter !== undefined ? { messagesAfter: notice.messagesAfter } : {}),
				...(notice.tokensAfter !== undefined ? { estimatedTokensAfter: notice.tokensAfter } : {}),
				...(maxInputTokens !== undefined ? { maxInputTokens } : {}),
				...(triggerTokens !== undefined ? { triggerTokens } : {}),
				...(targetTokens !== undefined ? { targetTokens } : {}),
				...(messageTargetTokens !== undefined ? { messageTargetTokens } : {}),
			},
		})
	}
	hasStateSubscribers() { return this.features.optional("streamPublisher")?.hasStateSubscribers === true }
	getActivePartialSnapshot() { const message = this.state.clineMessages.find((item) => item.ts === this.conversationProjection.activePartialTextTs); const text = getString(message, "text"); return this.conversationProjection.activePartialTextTs && text.trim() ? { textLength: text.length } : null }
	handlePartialIdle() { this.taskState.update(); this.broadcastState().catch((error) => console.error(error)) }
	requestStateBroadcast() { this.broadcastState().catch((error) => console.error(error)) }

	async dispose() {
		const sessionId = ["starting", "streaming", "awaiting_user", "cancelling"].includes(this.taskSession.status)
			? this.taskSession.currentSessionId
			: ""
		const cancellation = await this.cancelTaskWork(sessionId)
		if (!cancellation.succeeded) this.logger.log("sidecar", "shutdownCancellationIncomplete", { sessionId, failures: cancellation.failures })
		this.runtimeMonitoring.clearAll()
		this.features.optional("terminalActivity")?.dispose()
		this.features.optional("changeTracking")?.dispose()
		this.features.optional("streamPublisher")?.dispose()
		this.streamingRpcRouter.clear()
		this.stateStreamRefresh.dispose()
		this.approvals.clear({ approved: false, reason: "LIG VS webview router was disposed." })
		this.settlePendingQuestion("")
		this.flushPersistedStateSave()
		this.features.optional("oauthAuthorization")?.dispose()
	}

	isScheduledAgentsEnabled() {
		return this.state.scheduledAgentsEnabled === true || process.env.VSCLINE_ENABLE_AUTOMATION === "1"
	}

	async requestToolApproval(request: ApprovalRequestedEvent): Promise<ToolApprovalResult> {
		return this.toolApproval.execute(request)
	}

	async requestQuestion(question: string, options: string[], signal?: AbortSignal): Promise<AskQuestionResult> {
		if (signal?.aborted) throw createAbortError("Question was cancelled before it was shown.")
		this.taskSession.transition("awaiting_user", "question")
		this.taskSession.waitFor("question")
		this.logger.log("sdk->sidecar", "question.request", { question, options })
		this.settlePendingQuestion("")
		this.conversationMessages.removeAsks("followup")
		let resolveQuestion!: (value: AskQuestionResult) => void
		let rejectQuestion!: (error: Error) => void
		const result = new Promise<AskQuestionResult>((resolve, reject) => { resolveQuestion = resolve; rejectQuestion = reject })
		void result.catch(() => undefined)
		const onAbort = () => {
			if (this.pendingQuestion !== pending) return
			this.settlePendingQuestion("", createAbortError("Question was cancelled."))
			this.conversationMessages.removeAsks("followup")
		}
		const pending = {
			resolve: resolveQuestion,
			reject: rejectQuestion,
			dispose: () => signal?.removeEventListener("abort", onAbort),
		}
		this.pendingQuestion = pending
		signal?.addEventListener("abort", onAbort, { once: true })

		this.conversationMessages.add({
			type: "ask",
			ask: "followup",
			text: JSON.stringify({
				question,
				options,
			}),
		})
		this.taskState.update()
		try {
			await this.broadcastState()
		} catch (error) {
			this.settlePendingQuestion("", error instanceof Error ? error : new Error(String(error)))
			throw error
		}
		return result
	}

	private settlePendingQuestion(value: AskQuestionResult, error?: Error) {
		const pending = this.pendingQuestion
		if (!pending) return
		this.pendingQuestion = null
		pending.dispose()
		if (error) pending.reject(error)
		else pending.resolve(value)
	}

	handleSdkEvent(event: AgentRuntimeEvent) {
		this.runtimeEventIngress.handle(event)
	}

	async handle(envelope: WebviewEnvelope) {
		return this.rpcIngress.handle(envelope)
	}

	private async getPrimaryWorkspaceRoot() {
		const workspaceRoots = await this.host.workspaceClient.getWorkspacePaths({}).catch(() => [])
		return resolveUsableWorkingDirectory([workspaceRoots[0], String(this.state.currentTaskItem?.cwdOnTaskInitialization || "")])
	}

	private setWorktreesFeatureFlag(enabled: boolean) {
		const current = asRecord(this.state.worktreesEnabled)
		this.state.worktreesEnabled = {
			...current,
			user: current.user !== false,
			featureFlag: enabled,
		}
	}

	private buildMcpServerStreamMessages(response: unknown) {
		return this.streamingRpcRouter.mcpMessages(response)
	}

	getBrowserSettings(): BrowserSettings {
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

	getAutoApprovalSettings() { return this.state.autoApprovalSettings }

	getCommandExecutionSettings() {
		return {
			profileId: getString(this.state, "defaultTerminalProfile") || "visual-studio-command-host",
			reuseEnabled: this.state.terminalReuseEnabled !== false,
			foregroundWaitMs: Number(this.state.shellIntegrationTimeout) >= 1_000
				? Number(this.state.shellIntegrationTimeout)
				: 30_000,
			outputLineLimit: Number.isFinite(Number(this.state.terminalOutputLineLimit))
				? Math.min(5_000, Math.max(100, Math.round(Number(this.state.terminalOutputLineLimit))))
				: 500,
		}
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
			this.schedulePersistedStateSave()
			this.broadcastState().catch((error) => console.error(error))
		}
	}

	private schedulePersistedStateSave() {
		this.stateStore.schedule(() => createPersistedStateSnapshot(this.state))
	}

	private flushPersistedStateSave() {
		this.stateStore.flush(() => createPersistedStateSnapshot(this.state))
	}

	private async broadcastState() { await this.features.require("streamPublisher").broadcastState() }

	private buildStateMessages() { return this.features.require("streamPublisher").buildStateMessages() }

	private sendPartialMessage(message: Record<string, unknown> | undefined) { this.features.require("streamPublisher").sendPartial(message) }

}

function createAbortError(message: string) {
	const error = new Error(message)
	error.name = "AbortError"
	return error
}

function sdkSessionStatus(value: unknown) {
	const root = asRecord(value)
	const session = asRecord(root.session)
	return getString(session, "status")
		|| getString(session, "state")
		|| getString(root, "status")
		|| getString(root, "state")
}
