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

type Dependencies = Readonly<{
	settings: SettingsRpcHandler; account: AccountRpcHandler; browser: BrowserRpcHandler; terminal: TerminalRpcHandler
	task: TaskRpcHandler; checkpoint: CheckpointRpcHandler; hook: HookRpcHandler; scheduledAgent: ScheduledAgentRpcHandler
	worktree: WorktreeRpcHandler; mcp: McpRpcHandler; modelCatalog: ModelCatalogRpcHandler; file: FileRpcHandler
	instructionSettings: InstructionSettingsRpcHandler; uiWeb: UiWebRpcHandler; plugin: PluginRpcHandler
	stateMessages: () => unknown[]; mcpStreamMessages: (payload: unknown) => unknown[]
}>

export class WebviewUnaryRpcRouter {
	constructor(private readonly dependencies: Dependencies) {}

	async handle(key: string, requestId: string, message: unknown) {
		const d = this.dependencies
		const settings = decodeSettingsRpcCommand(key, message)
		if (settings) return this.withOptionalState(requestId, await d.settings.handle(settings))
		const account = decodeAccountRpcCommand(key, message)
		if (account) return this.withOptionalState(requestId, await d.account.handle(account))
		const browser = decodeBrowserRpcCommand(key, message)
		if (browser) return grpcHandled(grpcResponse(requestId, await d.browser.handle(browser), false))
		const terminal = decodeTerminalRpcCommand(key, message)
		if (terminal) return this.withOptionalState(requestId, await d.terminal.handle(terminal))
		const task = decodeTaskRpcCommand(key, message)
		if (task) return this.withOptionalState(requestId, await d.task.handle(task, requestId))
		const checkpoint = decodeCheckpointRpcCommand(key, message)
		if (checkpoint) return this.withOptionalState(requestId, await d.checkpoint.handle(checkpoint))
		const hook = decodeHookRpcCommand(key, message)
		if (hook) return grpcHandled(grpcResponse(requestId, await d.hook.handle(hook), false))
		const scheduledAgent = decodeScheduledAgentRpcCommand(key, message)
		if (scheduledAgent) return this.withOptionalState(requestId, await d.scheduledAgent.handle(scheduledAgent))
		const worktree = decodeWorktreeRpcCommand(key, message)
		if (worktree) return grpcHandled(grpcResponse(requestId, await d.worktree.handle(worktree), false))
		const mcp = decodeMcpRpcCommand(key, message)
		if (mcp) {
			const result = await d.mcp.handle(mcp)
			if (result.error) return grpcHandled(grpcError(requestId, result.error, false))
			return grpcHandled(grpcResponse(requestId, result.payload, false), ...(result.publishToStreams ? d.mcpStreamMessages(result.payload) : []))
		}
		const modelCatalog = decodeModelCatalogRpcCommand(key, message)
		if (modelCatalog) return grpcHandled(grpcResponse(requestId, await d.modelCatalog.handle(modelCatalog), false))
		const file = decodeFileRpcCommand(key, message)
		if (file) {
			const result = await d.file.handle(file)
			return grpcHandled(grpcResponse(requestId, result.payload, false), ...(result.includeStateMessages ? d.stateMessages() : []))
		}
		const instructions = decodeInstructionSettingsRpcCommand(key, message)
		if (instructions) return grpcHandled(grpcResponse(requestId, await d.instructionSettings.handle(instructions), false))
		const uiWeb = decodeUiWebRpcCommand(key, message)
		if (uiWeb) return grpcHandled(grpcResponse(requestId, await d.uiWeb.handle(uiWeb), false))
		const plugin = decodePluginRpcCommand(key)
		return plugin ? grpcHandled(grpcResponse(requestId, await d.plugin.handle(plugin), false)) : null
	}

	private withOptionalState(requestId: string, result: { payload: unknown; includeStateMessages?: boolean }) {
		return grpcHandled(grpcResponse(requestId, result.payload, false), ...(result.includeStateMessages ? this.dependencies.stateMessages() : []))
	}
}
