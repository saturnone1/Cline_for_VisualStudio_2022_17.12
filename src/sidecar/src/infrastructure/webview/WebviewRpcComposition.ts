import type { InteractionLoggerPort } from "../../application/ports/InteractionLoggerPort"
import type { SettingsRpcHandler } from "../../features/settings/SettingsRpcHandler"
import type { AccountRpcHandler } from "../../features/providers/AccountRpcHandler"
import type { BrowserRpcHandler } from "../../features/browser/BrowserRpcHandler"
import type { TerminalRpcHandler } from "../../features/terminal/TerminalRpcHandler"
import type { TaskRpcHandler } from "../../features/chat/TaskRpcHandler"
import type { CheckpointRpcHandler } from "../../features/checkpoints/CheckpointRpcHandler"
import type { HookRpcHandler } from "../../features/hooks/HookRpcHandler"
import type { ScheduledAgentRpcHandler } from "../../features/scheduledAgents/ScheduledAgentRpcHandler"
import type { WorktreeRpcHandler } from "../../features/worktrees/WorktreeRpcHandler"
import type { McpRpcHandler } from "../../features/mcp/McpRpcHandler"
import type { ModelCatalogRpcHandler } from "../../features/providers/ModelCatalogRpcHandler"
import type { FileRpcHandler } from "../../features/files/FileRpcHandler"
import type { InstructionSettingsRpcHandler } from "../../features/settings/InstructionSettingsRpcHandler"
import type { UiWebRpcHandler } from "../../features/web/UiWebRpcHandler"
import type { PluginRpcHandler } from "../../features/plugins/PluginRpcHandler"
import { StreamingRpcHandler } from "../../features/web/StreamingRpcHandler"
import { createUnauthenticatedAccountState } from "../auth/ProviderAuthSupport"
import { WebviewRpcIngress } from "./WebviewRpcIngress"
import { WebviewStreamingRpcRouter } from "./WebviewStreamingRpcRouter"
import { WebviewUnaryRpcRouter } from "./WebviewUnaryRpcRouter"

type Handlers = Readonly<{
	settings: SettingsRpcHandler; account: AccountRpcHandler; browser: BrowserRpcHandler; terminal: TerminalRpcHandler
	task: TaskRpcHandler; checkpoint: CheckpointRpcHandler; hook: HookRpcHandler; scheduledAgent: ScheduledAgentRpcHandler
	worktree: WorktreeRpcHandler; mcp: McpRpcHandler; modelCatalog: ModelCatalogRpcHandler; file: FileRpcHandler
	instructionSettings: InstructionSettingsRpcHandler; uiWeb: UiWebRpcHandler; plugin: PluginRpcHandler
}>

type Dependencies = Readonly<{
	logger: InteractionLoggerPort
	handlers: Handlers
	scheduleStateRefresh: () => void
	subscribeState: (requestId: string) => void
	subscribePartial: (requestId: string) => void
	unsubscribe: (requestId: string) => boolean
	stateMessages: () => unknown[]
	mcpStreamMessages: (payload: unknown) => unknown[]
	onUnaryError: (error: unknown) => Promise<void>
	slowRequestThresholdMs: () => number
}>

export function createWebviewRpcComposition(dependencies: Dependencies) {
	const unary = new WebviewUnaryRpcRouter({
		...dependencies.handlers,
		stateMessages: dependencies.stateMessages,
		mcpStreamMessages: dependencies.mcpStreamMessages,
	})
	const streamingHandler = new StreamingRpcHandler({
		scheduleStateRefresh: dependencies.scheduleStateRefresh,
		subscribeState: dependencies.subscribeState,
		subscribePartial: dependencies.subscribePartial,
		unauthenticatedAccount: createUnauthenticatedAccountState,
		mcpServers: async () => (await dependencies.handlers.mcp.handle({ type: "list" })).payload,
		mcpMarketplace: async () => (await dependencies.handlers.mcp.handle({ type: "marketplace" })).payload,
	})
	const streaming = new WebviewStreamingRpcRouter({ handler: streamingHandler, unsubscribeTransport: dependencies.unsubscribe })
	return {
		streaming,
		ingress: new WebviewRpcIngress({
			logger: dependencies.logger,
			streaming,
			unary,
			onUnaryError: dependencies.onUnaryError,
			slowRequestThresholdMs: dependencies.slowRequestThresholdMs,
		}),
	}
}
