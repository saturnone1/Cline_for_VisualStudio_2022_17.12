import { randomUUID } from "node:crypto"
import type { JsonRpcConnection } from "../infrastructure/transport/JsonRpcConnection"
import { JsonRpcWebviewTransport } from "../infrastructure/transport/JsonRpcConnection"
import { interactionLogger } from "../infrastructure/diagnostics/InteractionLog"
import { JsonStateStore } from "../infrastructure/persistence/JsonStateStore"
import { VisualStudioHostProvider } from "../infrastructure/host/VisualStudioHostProvider"
import { VisualStudioWebviewBackend } from "../infrastructure/webview/VisualStudioWebviewBackend"
import { VisualStudioWebviewController } from "../presentation/webview/VisualStudioWebviewController"
import { ClineSdkRuntime } from "../infrastructure/sdk/ClineSdkRuntime"
import { TaskSessionUseCase } from "../application/useCases/TaskSessionUseCase"
import { TaskLifecycleUseCase } from "../application/useCases/TaskLifecycleUseCase"
import { StatePersistenceUseCase } from "../application/useCases/StatePersistenceUseCase"
import { McpHandler } from "../features/mcp/McpHandler"
import { SendMessageHandler } from "../features/chat/sendMessage/SendMessageHandler"
import { StartTaskHandler } from "../features/chat/startTask/StartTaskHandler"
import { CancelTaskHandler } from "../features/chat/cancelTask/CancelTaskHandler"
import { BrowserHandler } from "../features/browser/BrowserHandler"
import { BrowserDevToolsAdapter } from "../infrastructure/browser/BrowserDevToolsAdapter"
import { NodeWorktreeOperationsAdapter } from "../infrastructure/worktree/NodeWorktreeOperationsAdapter"
import { WorktreeQueryHandler } from "../features/worktrees/WorktreeQueryHandler"
import { WorktreeMutationHandler } from "../features/worktrees/WorktreeMutationHandler"
import { FetchOAuthTokenExchangeAdapter } from "../infrastructure/auth/FetchOAuthTokenExchangeAdapter"
import { OAuthTokenHandler } from "../features/providers/OAuthTokenHandler"
import { ProviderCredentialHandler } from "../features/providers/ProviderCredentialHandler"
import { ProviderCredentialEnvironmentAdapter } from "../infrastructure/auth/ProviderCredentialEnvironmentAdapter"
import { OAuthCallbackCoordinator } from "../features/providers/OAuthCallbackCoordinator"
import { OAuthAuthorizationHandler } from "../features/providers/OAuthAuthorizationHandler"
import { NodeOAuthCallbackListener } from "../infrastructure/auth/NodeOAuthCallbackListener"
import { ProviderOAuthAuthorizationAdapter } from "../infrastructure/auth/ProviderOAuthAuthorizationAdapter"
import { OAuthCallbackHandler } from "../features/providers/OAuthCallbackHandler"
import { ProviderAuthActionHandler } from "../features/providers/ProviderAuthActionHandler"
import { VisualStudioProviderAuthUiAdapter } from "../infrastructure/auth/VisualStudioProviderAuthUiAdapter"
import { ScheduledAgentHandler } from "../features/scheduledAgents/ScheduledAgentHandler"
import { LocalScheduledAgentStore } from "../infrastructure/persistence/LocalScheduledAgentStore"
import { HookSettingsHandler } from "../features/hooks/HookSettingsHandler"
import { LocalHookStore } from "../infrastructure/hooks/LocalHookStore"
import { HookExecutionHandler } from "../features/hooks/HookExecutionHandler"
import { ProcessHookExecutionAdapter } from "../infrastructure/hooks/ProcessHookExecutionAdapter"
import { CheckpointHandler } from "../features/checkpoints/CheckpointHandler"
import { TerminalActivityMonitor } from "../infrastructure/conversation/TerminalActivityMonitor"
import { TaskActivityMonitor } from "../features/runtime/TaskActivityMonitor"
import { PartialStateScheduler } from "../features/runtime/PartialStateScheduler"
import { SendLatencyMonitor } from "../features/runtime/SendLatencyMonitor"
import { ChangeTrackingHandler } from "../infrastructure/workspace/ChangeTrackingHandler"
import { ProviderModelCatalogHandler } from "../infrastructure/models/ProviderModelCatalogHandler"
import { WebviewStreamPublisher } from "../infrastructure/webview/WebviewStreamPublisher"
import { SdkSettingsHandler } from "../features/settings/SdkSettingsHandler"

export function createSidecarConnectionScope(connection: JsonRpcConnection, stateStore: JsonStateStore) {
	const host = VisualStudioHostProvider.create(connection), transport = new JsonRpcWebviewTransport(connection)
	const backend = new VisualStudioWebviewBackend(host, transport, interactionLogger, new StatePersistenceUseCase(stateStore, readPositiveIntEnv("VSCLINE_STATE_SAVE_DEBOUNCE_MS", 250)), new TaskLifecycleUseCase())
	const webview = new VisualStudioWebviewController(backend)
	const runtime = new ClineSdkRuntime(host, __dirname, (event) => webview.handleSdkEvent(event), (request) => webview.requestToolApproval(request), (question, options) => webview.requestQuestion(question, options), () => webview.isScheduledAgentsEnabled())
	backend.setAgentEngine(runtime); backend.setTaskSessionUseCase(new TaskSessionUseCase(runtime)); backend.setMcpHandler(new McpHandler(runtime)); backend.setSendMessageHandler(new SendMessageHandler(runtime)); backend.setStartTaskHandler(new StartTaskHandler(runtime)); backend.setCancelTaskHandler(new CancelTaskHandler(runtime))
	backend.setBrowserHandler(new BrowserHandler(new BrowserDevToolsAdapter(), randomUUID, readPositiveIntEnv("VSCLINE_BROWSER_SESSION_TTL_MS", 30 * 60 * 1000)))
	const worktrees = new NodeWorktreeOperationsAdapter(host), worktreeQueries = new WorktreeQueryHandler(worktrees, interactionLogger)
	backend.setWorktreeQueryHandler(worktreeQueries); backend.setWorktreeMutationHandler(new WorktreeMutationHandler(worktrees, worktreeQueries, interactionLogger))
	const tokenExchange = new FetchOAuthTokenExchangeAdapter(), oauthTokens = new OAuthTokenHandler(tokenExchange, interactionLogger), credentials = new ProviderCredentialHandler(new ProviderCredentialEnvironmentAdapter(), tokenExchange, runtime)
	const callbacks = new OAuthCallbackCoordinator(interactionLogger, readPositiveIntEnv("VSCLINE_OAUTH_CALLBACK_TTL_MS", 15 * 60 * 1000))
	backend.setOAuthCallbackServices(new OAuthAuthorizationHandler(callbacks, new NodeOAuthCallbackListener(readPositiveIntEnv("VSCLINE_OAUTH_CALLBACK_PORT", 0)), new ProviderOAuthAuthorizationAdapter(), interactionLogger, randomUUID), new OAuthCallbackHandler(callbacks, oauthTokens, credentials, interactionLogger))
	backend.setProviderCredentialHandler(credentials); backend.setProviderAuthActionHandler(new ProviderAuthActionHandler(new VisualStudioProviderAuthUiAdapter(host), interactionLogger)); backend.setScheduledAgentHandler(new ScheduledAgentHandler(new LocalScheduledAgentStore(), () => backend.isScheduledAgentsEnabled()))
	const hooks = new HookSettingsHandler(new LocalHookStore()); backend.setHookSettingsHandler(hooks); backend.setHookExecutionHandler(new HookExecutionHandler(hooks, new ProcessHookExecutionAdapter(), interactionLogger)); backend.setCheckpointHandler(new CheckpointHandler(runtime))
	backend.setTerminalActivityMonitor(new TerminalActivityMonitor(host.workspaceClient, interactionLogger, (text) => backend.updateTerminalActivity(text), () => backend.getUiLanguage())); backend.setTaskActivityMonitor(new TaskActivityMonitor(interactionLogger, () => backend.hasActiveTask(), () => backend.hasActivePartialText(), () => backend.handleTaskIdleLongRunning(), readPositiveIntEnv("VSCLINE_TASK_IDLE_NOTICE_MS", 30000), readPositiveIntEnv("VSCLINE_TASK_IDLE_COMPLETE_MS", 600_000)))
	backend.setPartialStateScheduler(new PartialStateScheduler(interactionLogger, () => backend.hasStateSubscribers(), () => backend.getActivePartialSnapshot(), () => backend.handlePartialIdle(), () => backend.requestStateBroadcast(), readPositiveIntEnv("VSCLINE_PARTIAL_IDLE_COMPLETE_MS", 45000), readPositiveIntEnv("VSCLINE_PARTIAL_STATE_BROADCAST_MS", 5000))); backend.setSendLatencyMonitor(new SendLatencyMonitor(interactionLogger))
	backend.setChangeTrackingHandler(new ChangeTrackingHandler(host.workspaceClient, (text) => backend.publishChangeTranscript(text))); backend.setProviderModelCatalogHandler(new ProviderModelCatalogHandler((modelId) => backend.applyDefaultOllamaModel(modelId))); backend.setWebviewStreamPublisher(new WebviewStreamPublisher(transport, interactionLogger, () => backend.serializeState()))
	backend.setSdkSettingsHandler(new SdkSettingsHandler(runtime))
	return { runtime, webview, roundtrip: () => host.roundtrip() }
}

function readPositiveIntEnv(name: string, fallback: number) { const value = Number(process.env[name]); return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback }
