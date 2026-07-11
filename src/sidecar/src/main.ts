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
		const oauthCallbacks = new OAuthCallbackCoordinator(interactionLogger, readPositiveIntEnv("VSCLINE_OAUTH_CALLBACK_TTL_MS", 15 * 60 * 1000))
		backend.setOAuthCallbackServices(oauthCallbacks, new OAuthAuthorizationHandler(oauthCallbacks, new NodeOAuthCallbackListener(readPositiveIntEnv("VSCLINE_OAUTH_CALLBACK_PORT", 0)), new ProviderOAuthAuthorizationAdapter(), interactionLogger, randomUUID))
		const oauthTokens = new FetchOAuthTokenExchangeAdapter()
		backend.setOAuthTokenHandler(new OAuthTokenHandler(oauthTokens, interactionLogger))
		backend.setProviderCredentialHandler(new ProviderCredentialHandler(new ProviderCredentialEnvironmentAdapter(), oauthTokens, runtime))
		backend.setProviderAuthActionHandler(new ProviderAuthActionHandler(new VisualStudioProviderAuthUiAdapter(host), interactionLogger))
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
