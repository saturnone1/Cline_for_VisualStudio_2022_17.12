import { randomUUID } from "node:crypto"
import { McpHandler } from "./features/mcp/McpHandler"
import { BrowserHandler } from "./features/browser/BrowserHandler"
import { WorktreeQueryHandler } from "./features/worktrees/WorktreeQueryHandler"
import { WorktreeMutationHandler } from "./features/worktrees/WorktreeMutationHandler"
import { OAuthCallbackCoordinator } from "./features/providers/OAuthCallbackCoordinator"
import { OAuthTokenHandler } from "./features/providers/OAuthTokenHandler"
import { ProviderCredentialHandler } from "./features/providers/ProviderCredentialHandler"
import { ProviderAuthActionHandler } from "./features/providers/ProviderAuthActionHandler"
import { OAuthAuthorizationHandler } from "./features/providers/OAuthAuthorizationHandler"
import { OAuthCallbackHandler } from "./features/providers/OAuthCallbackHandler"
import { TaskSessionUseCase } from "./application/useCases/TaskSessionUseCase"
import { TaskLifecycleUseCase } from "./application/useCases/TaskLifecycleUseCase"
import { StatePersistenceUseCase } from "./application/useCases/StatePersistenceUseCase"
import { flushInteractionLog, interactionLogger } from "./infrastructure/diagnostics/InteractionLog"
import { VisualStudioHostProvider } from "./infrastructure/host/VisualStudioHostProvider"
import { JsonStateStore } from "./infrastructure/persistence/JsonStateStore"
import { ClineSdkRuntime } from "./infrastructure/sdk/ClineSdkRuntime"
import { JsonRpcWebviewTransport } from "./infrastructure/transport/JsonRpcConnection"
import { SidecarRpcServer } from "./infrastructure/transport/SidecarRpcServer"
import { VisualStudioWebviewBackend } from "./infrastructure/webview/VisualStudioWebviewBackend"
import { VisualStudioWebviewController } from "./presentation/webview/VisualStudioWebviewController"
import { SendMessageHandler } from "./features/chat/sendMessage/SendMessageHandler"
import { StartTaskHandler } from "./features/chat/startTask/StartTaskHandler"
import { CancelTaskHandler } from "./features/chat/cancelTask/CancelTaskHandler"
import { BrowserDevToolsAdapter } from "./infrastructure/browser/BrowserDevToolsAdapter"
import { NodeWorktreeOperationsAdapter } from "./infrastructure/worktree/NodeWorktreeOperationsAdapter"
import { NodeOAuthCallbackListener } from "./infrastructure/auth/NodeOAuthCallbackListener"
import { FetchOAuthTokenExchangeAdapter } from "./infrastructure/auth/FetchOAuthTokenExchangeAdapter"
import { ProviderCredentialEnvironmentAdapter } from "./infrastructure/auth/ProviderCredentialEnvironmentAdapter"
import { VisualStudioProviderAuthUiAdapter } from "./infrastructure/auth/VisualStudioProviderAuthUiAdapter"
import { ProviderOAuthAuthorizationAdapter } from "./infrastructure/auth/ProviderOAuthAuthorizationAdapter"
import { ScheduledAgentHandler } from "./features/scheduledAgents/ScheduledAgentHandler"
import { LocalScheduledAgentStore } from "./infrastructure/persistence/LocalScheduledAgentStore"
import { HookSettingsHandler } from "./features/hooks/HookSettingsHandler"
import { LocalHookStore } from "./infrastructure/hooks/LocalHookStore"
import { HookExecutionHandler } from "./features/hooks/HookExecutionHandler"
import { ProcessHookExecutionAdapter } from "./infrastructure/hooks/ProcessHookExecutionAdapter"
import { CheckpointHandler } from "./features/checkpoints/CheckpointHandler"
import { TerminalActivityMonitor } from "./infrastructure/conversation/TerminalActivityMonitor"
import { TaskActivityMonitor } from "./features/runtime/TaskActivityMonitor"
import { PartialStateScheduler } from "./features/runtime/PartialStateScheduler"
import { SendLatencyMonitor } from "./features/runtime/SendLatencyMonitor"
import { ChangeTrackingHandler } from "./infrastructure/workspace/ChangeTrackingHandler"
import { ProviderModelCatalogHandler } from "./infrastructure/models/ProviderModelCatalogHandler"

const pipeName = getArg("--pipe")
if (!pipeName) {
	console.error("Missing required --pipe argument.")
	process.exit(2)
}

const stateStore = JsonStateStore.createDefault()
const server = new SidecarRpcServer(
	pipeName,
	interactionLogger,
	(connection) => {
		const host = VisualStudioHostProvider.create(connection)
		const statePersistence = new StatePersistenceUseCase(stateStore, readPositiveIntEnv("VSCLINE_STATE_SAVE_DEBOUNCE_MS", 250))
		const backend = new VisualStudioWebviewBackend(host, new JsonRpcWebviewTransport(connection), interactionLogger, statePersistence, new TaskLifecycleUseCase())
		const webview = new VisualStudioWebviewController(backend)
		const runtime = new ClineSdkRuntime(
			host,
			__dirname,
			(event) => webview.handleSdkEvent(event),
			(request) => webview.requestToolApproval(request),
			(question, options) => webview.requestQuestion(question, options),
			() => webview.isScheduledAgentsEnabled(),
		)
		backend.setAgentEngine(runtime)
		backend.setTaskSessionUseCase(new TaskSessionUseCase(runtime))
		backend.setMcpHandler(new McpHandler(runtime))
		backend.setSendMessageHandler(new SendMessageHandler(runtime))
		backend.setStartTaskHandler(new StartTaskHandler(runtime))
		backend.setCancelTaskHandler(new CancelTaskHandler(runtime))
		backend.setBrowserHandler(new BrowserHandler(new BrowserDevToolsAdapter(), randomUUID, readPositiveIntEnv("VSCLINE_BROWSER_SESSION_TTL_MS", 30 * 60 * 1000)))
		const worktreeOperations = new NodeWorktreeOperationsAdapter(host)
		const worktreeQueries = new WorktreeQueryHandler(worktreeOperations, interactionLogger)
		backend.setWorktreeQueryHandler(worktreeQueries)
		backend.setWorktreeMutationHandler(new WorktreeMutationHandler(worktreeOperations, worktreeQueries, interactionLogger))
		const oauthTokens = new FetchOAuthTokenExchangeAdapter()
		const oauthTokenHandler = new OAuthTokenHandler(oauthTokens, interactionLogger)
		const providerCredentials = new ProviderCredentialHandler(new ProviderCredentialEnvironmentAdapter(), oauthTokens, runtime)
		const oauthCallbacks = new OAuthCallbackCoordinator(interactionLogger, readPositiveIntEnv("VSCLINE_OAUTH_CALLBACK_TTL_MS", 15 * 60 * 1000))
		backend.setOAuthCallbackServices(new OAuthAuthorizationHandler(oauthCallbacks, new NodeOAuthCallbackListener(readPositiveIntEnv("VSCLINE_OAUTH_CALLBACK_PORT", 0)), new ProviderOAuthAuthorizationAdapter(), interactionLogger, randomUUID), new OAuthCallbackHandler(oauthCallbacks, oauthTokenHandler, providerCredentials, interactionLogger))
		backend.setProviderCredentialHandler(providerCredentials)
		backend.setProviderAuthActionHandler(new ProviderAuthActionHandler(new VisualStudioProviderAuthUiAdapter(host), interactionLogger))
		backend.setScheduledAgentHandler(new ScheduledAgentHandler(new LocalScheduledAgentStore(), () => backend.isScheduledAgentsEnabled()))
		const hookSettings = new HookSettingsHandler(new LocalHookStore())
		backend.setHookSettingsHandler(hookSettings)
		backend.setHookExecutionHandler(new HookExecutionHandler(hookSettings, new ProcessHookExecutionAdapter(), interactionLogger))
		backend.setCheckpointHandler(new CheckpointHandler(runtime))
		backend.setTerminalActivityMonitor(new TerminalActivityMonitor(host.workspaceClient, interactionLogger, (text) => backend.updateTerminalActivity(text), () => backend.getUiLanguage()))
		backend.setTaskActivityMonitor(new TaskActivityMonitor(interactionLogger, () => backend.hasActiveTask(), () => backend.hasActivePartialText(), () => backend.handleTaskIdleLongRunning(), readPositiveIntEnv("VSCLINE_TASK_IDLE_NOTICE_MS", 30000), readPositiveIntEnv("VSCLINE_TASK_IDLE_COMPLETE_MS", 600_000)))
		backend.setPartialStateScheduler(new PartialStateScheduler(interactionLogger, () => backend.hasStateSubscribers(), () => backend.getActivePartialSnapshot(), () => backend.handlePartialIdle(), () => backend.requestStateBroadcast(), readPositiveIntEnv("VSCLINE_PARTIAL_IDLE_COMPLETE_MS", 45000), readPositiveIntEnv("VSCLINE_PARTIAL_STATE_BROADCAST_MS", 5000)))
		backend.setSendLatencyMonitor(new SendLatencyMonitor(interactionLogger))
		backend.setChangeTrackingHandler(new ChangeTrackingHandler(host.workspaceClient, (text) => backend.publishChangeTranscript(text)))
		backend.setProviderModelCatalogHandler(new ProviderModelCatalogHandler((modelId) => backend.applyDefaultOllamaModel(modelId)))
		return { runtime, webview, roundtrip: () => host.roundtrip() }
	},
	flushInteractionLog,
)
server.start()

function getArg(name: string): string | null {
	const index = process.argv.indexOf(name)
	return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null
}

function readPositiveIntEnv(name: string, fallback: number) {
	const value = Number(process.env[name])
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}
