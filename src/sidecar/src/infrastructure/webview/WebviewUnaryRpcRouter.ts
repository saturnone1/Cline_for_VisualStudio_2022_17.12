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
import { decodeSettingsRpcCommand } from "./SettingsRpcDecoder"
import { decodeAccountRpcCommand } from "./AccountRpcDecoder"
import { decodeBrowserRpcCommand } from "./BrowserRpcDecoder"
import { decodeTerminalRpcCommand } from "./TerminalRpcDecoder"
import { decodeTaskRpcCommand } from "./TaskRpcDecoder"
import { decodeCheckpointRpcCommand } from "./CheckpointRpcDecoder"
import { decodeHookRpcCommand } from "./HookRpcDecoder"
import { decodeScheduledAgentRpcCommand } from "./ScheduledAgentRpcDecoder"
import { decodeWorktreeRpcCommand } from "./WorktreeRpcDecoder"
import { decodeMcpRpcCommand } from "./McpRpcDecoder"
import { decodeModelCatalogRpcCommand } from "./ModelCatalogRpcDecoder"
import { decodeFileRpcCommand } from "./FileRpcDecoder"
import { decodeInstructionSettingsRpcCommand } from "./InstructionSettingsRpcDecoder"
import { decodeUiWebRpcCommand } from "./UiWebRpcDecoder"
import { decodePluginRpcCommand } from "./PluginRpcDecoder"
import { grpcError, grpcHandled, grpcResponse } from "./WebviewGrpcSupport"
import { webviewRpcOperation, type WebviewRpcSidecarRoute } from "../../application/dto/generated/WebviewRpcContract"

type Dependencies = Readonly<{
	settings: SettingsRpcHandler; account: AccountRpcHandler; browser: BrowserRpcHandler; terminal: TerminalRpcHandler
	task: TaskRpcHandler; checkpoint: CheckpointRpcHandler; hook: HookRpcHandler; scheduledAgent: ScheduledAgentRpcHandler
	worktree: WorktreeRpcHandler; mcp: McpRpcHandler; modelCatalog: ModelCatalogRpcHandler; file: FileRpcHandler
	instructionSettings: InstructionSettingsRpcHandler; uiWeb: UiWebRpcHandler; plugin: PluginRpcHandler
	stateMessages: () => unknown[]; mcpStreamMessages: (payload: unknown) => unknown[]
}>

type UnaryRoute = Exclude<WebviewRpcSidecarRoute, "stream">
type UnaryRouteResult = ReturnType<typeof grpcHandled> | null
type UnaryRouteHandler = (key: string, requestId: string, message: unknown) => Promise<UnaryRouteResult>
type UnaryRouteRegistry = Record<UnaryRoute, UnaryRouteHandler>

export class WebviewUnaryRpcRouter {
	private readonly routes: UnaryRouteRegistry

	constructor(private readonly dependencies: Dependencies) {
		const d = dependencies
		this.routes = {
			settings: async (key, requestId, message) => {
				const command = decodeSettingsRpcCommand(key, message)
				return command ? this.withOptionalState(requestId, await d.settings.handle(command)) : null
			},
			account: async (key, requestId, message) => {
				const command = decodeAccountRpcCommand(key, message)
				return command ? this.withOptionalState(requestId, await d.account.handle(command)) : null
			},
			browser: async (key, requestId, message) => {
				const command = decodeBrowserRpcCommand(key, message)
				return command ? grpcHandled(grpcResponse(requestId, await d.browser.handle(command), false)) : null
			},
			terminal: async (key, requestId, message) => {
				const command = decodeTerminalRpcCommand(key, message)
				return command ? this.withOptionalState(requestId, await d.terminal.handle(command)) : null
			},
			task: async (key, requestId, message) => {
				const command = decodeTaskRpcCommand(key, message)
				return command ? this.withOptionalState(requestId, await d.task.handle(command, requestId)) : null
			},
			checkpoint: async (key, requestId, message) => {
				const command = decodeCheckpointRpcCommand(key, message)
				return command ? this.withOptionalState(requestId, await d.checkpoint.handle(command)) : null
			},
			hook: async (key, requestId, message) => {
				const command = decodeHookRpcCommand(key, message)
				return command ? grpcHandled(grpcResponse(requestId, await d.hook.handle(command), false)) : null
			},
			scheduledAgent: async (key, requestId, message) => {
				const command = decodeScheduledAgentRpcCommand(key, message)
				return command ? this.withOptionalState(requestId, await d.scheduledAgent.handle(command)) : null
			},
			worktree: async (key, requestId, message) => {
				const command = decodeWorktreeRpcCommand(key, message)
				return command ? grpcHandled(grpcResponse(requestId, await d.worktree.handle(command), false)) : null
			},
			mcp: (key, requestId, message) => this.handleMcp(key, requestId, message),
			modelCatalog: async (key, requestId, message) => {
				const command = decodeModelCatalogRpcCommand(key, message)
				return command ? grpcHandled(grpcResponse(requestId, await d.modelCatalog.handle(command), false)) : null
			},
			file: (key, requestId, message) => this.handleFile(key, requestId, message),
			instructionSettings: async (key, requestId, message) => {
				const command = decodeInstructionSettingsRpcCommand(key, message)
				return command ? grpcHandled(grpcResponse(requestId, await d.instructionSettings.handle(command), false)) : null
			},
			uiWeb: async (key, requestId, message) => {
				const command = decodeUiWebRpcCommand(key, message)
				return command ? grpcHandled(grpcResponse(requestId, await d.uiWeb.handle(command), false)) : null
			},
			plugin: async (key, requestId) => {
				const command = decodePluginRpcCommand(key)
				return command ? grpcHandled(grpcResponse(requestId, await d.plugin.handle(command), false)) : null
			},
		}
	}

	async handle(key: string, requestId: string, message: unknown) {
		const separator = key.indexOf(".")
		const operation = separator > 0 ? webviewRpcOperation(key.slice(0, separator), key.slice(separator + 1)) : undefined
		const route = operation && "route" in operation ? operation.route : undefined
		if (!route || route === "stream") return null
		return this.routes[route](key, requestId, message)
	}

	private async handleMcp(key: string, requestId: string, message: unknown) {
		const command = decodeMcpRpcCommand(key, message)
		if (!command) return null
		const result = await this.dependencies.mcp.handle(command)
		if (result.error) return grpcHandled(grpcError(requestId, result.error, false))
		return grpcHandled(grpcResponse(requestId, result.payload, false), ...(result.publishToStreams ? this.dependencies.mcpStreamMessages(result.payload) : []))
	}

	private async handleFile(key: string, requestId: string, message: unknown) {
		const command = decodeFileRpcCommand(key, message)
		if (!command) return null
		const result = await this.dependencies.file.handle(command)
		return grpcHandled(grpcResponse(requestId, result.payload, false), ...(result.includeStateMessages ? this.dependencies.stateMessages() : []))
	}

	private withOptionalState(requestId: string, result: { payload: unknown; includeStateMessages?: boolean }) {
		return grpcHandled(grpcResponse(requestId, result.payload, false), ...(result.includeStateMessages ? this.dependencies.stateMessages() : []))
	}
}
