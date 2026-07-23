import { randomUUID } from "node:crypto"
import { readPositiveIntEnv } from "../infrastructure/configuration/RuntimeEnvironment"
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
import { createBrowserAgentTool } from "../features/browser/BrowserAgentTool"
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
import { SdkSettingsHandler } from "../features/settings/SdkSettingsHandler"
import type { RuntimeWebviewFeatures } from "../infrastructure/webview/WebviewFeatureRegistry"

export function createSidecarConnectionScope(connection: JsonRpcConnection, stateStore: JsonStateStore) {
	const host = VisualStudioHostProvider.create(connection), transport = new JsonRpcWebviewTransport(connection)
	const backend = new VisualStudioWebviewBackend(host, transport, interactionLogger, new StatePersistenceUseCase(
		stateStore,
		readPositiveIntEnv("VSCLINE_STATE_SAVE_DEBOUNCE_MS", 250),
		readPositiveIntEnv("VSCLINE_STATE_SAVE_MAX_WAIT_MS", 5_000),
	), new TaskLifecycleUseCase())
	const webview = new VisualStudioWebviewController(backend)
	const browser = new BrowserHandler(new BrowserDevToolsAdapter(), randomUUID, readPositiveIntEnv("VSCLINE_BROWSER_SESSION_TTL_MS", 30 * 60 * 1000))
	const runtime = new ClineSdkRuntime(host, __dirname, (event) => webview.handleSdkEvent(event), (request) => webview.requestToolApproval(request), (question, options) => webview.requestQuestion(question, options), () => webview.isScheduledAgentsEnabled(), () => {
		const tool = createBrowserAgentTool(browser, () => backend.getBrowserSettings())
		return tool ? [tool] : []
	})
	const worktrees = new NodeWorktreeOperationsAdapter(host), worktreeQueries = new WorktreeQueryHandler(worktrees, interactionLogger)
	const tokenExchange = new FetchOAuthTokenExchangeAdapter(), oauthTokens = new OAuthTokenHandler(tokenExchange, interactionLogger), credentials = new ProviderCredentialHandler(new ProviderCredentialEnvironmentAdapter(), tokenExchange, runtime)
	const callbacks = new OAuthCallbackCoordinator(interactionLogger, readPositiveIntEnv("VSCLINE_OAUTH_CALLBACK_TTL_MS", 15 * 60 * 1000))
	const hooks = new HookSettingsHandler(new LocalHookStore())
	const features = {
		agentEngine: runtime,
		taskSessions: new TaskSessionUseCase(runtime),
		mcp: new McpHandler(runtime),
		sendMessage: new SendMessageHandler(runtime),
		startTask: new StartTaskHandler(runtime),
		cancelTask: new CancelTaskHandler(runtime),
		browser,
		worktreeQueries,
		worktreeMutations: new WorktreeMutationHandler(worktrees, worktreeQueries, interactionLogger),
		oauthAuthorization: new OAuthAuthorizationHandler(callbacks, new NodeOAuthCallbackListener(readPositiveIntEnv("VSCLINE_OAUTH_CALLBACK_PORT", 0)), new ProviderOAuthAuthorizationAdapter(), interactionLogger, randomUUID),
		oauthCallback: new OAuthCallbackHandler(callbacks, oauthTokens, credentials, interactionLogger),
		providerCredentials: credentials,
		providerAuthActions: new ProviderAuthActionHandler(new VisualStudioProviderAuthUiAdapter(host), interactionLogger),
		scheduledAgents: new ScheduledAgentHandler(new LocalScheduledAgentStore(), () => backend.isScheduledAgentsEnabled()),
		hookSettings: hooks,
		hookExecution: new HookExecutionHandler(hooks, new ProcessHookExecutionAdapter(), interactionLogger),
		checkpoints: new CheckpointHandler(runtime),
		terminalActivity: new TerminalActivityMonitor(host.workspaceClient, interactionLogger, (text) => backend.updateTerminalActivity(text), () => backend.getUiLanguage()),
		taskActivity: new TaskActivityMonitor(interactionLogger, () => backend.hasActiveTask(), () => backend.hasActivePartialText(), (idleForMs, reason) => backend.handleTaskIdleWaiting(idleForMs, reason), () => backend.handleTaskIdleLongRunning(), readPositiveIntEnv("VSCLINE_TASK_IDLE_NOTICE_MS", 30000), readPositiveIntEnv("VSCLINE_TASK_IDLE_COMPLETE_MS", 600_000)),
		partialState: new PartialStateScheduler(interactionLogger, () => backend.hasStateSubscribers(), () => backend.getActivePartialSnapshot(), () => backend.handlePartialIdle(), () => backend.requestStateBroadcast(), readPositiveIntEnv("VSCLINE_PARTIAL_IDLE_COMPLETE_MS", 45000), readPositiveIntEnv("VSCLINE_PARTIAL_STATE_BROADCAST_MS", 5000)),
		sendLatency: new SendLatencyMonitor(interactionLogger),
		changeTracking: new ChangeTrackingHandler(host.workspaceClient, (text) => backend.publishChangeTranscript(text)),
		providerModelCatalogs: new ProviderModelCatalogHandler((modelId) => backend.applyDefaultOllamaModel(modelId)),
		sdkSettings: new SdkSettingsHandler(runtime),
	} satisfies RuntimeWebviewFeatures
	backend.configureFeatures(features)
	return { runtime, webview, roundtrip: () => host.roundtrip() }
}
