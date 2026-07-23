import { BrowserRpcHandler } from "../../features/browser/BrowserRpcHandler"
import { TaskRpcHandler } from "../../features/chat/TaskRpcHandler"
import { CheckpointRpcHandler } from "../../features/checkpoints/CheckpointRpcHandler"
import { FileRpcHandler } from "../../features/files/FileRpcHandler"
import { HookRpcHandler } from "../../features/hooks/HookRpcHandler"
import { McpRpcHandler } from "../../features/mcp/McpRpcHandler"
import { PluginRpcHandler } from "../../features/plugins/PluginRpcHandler"
import { AccountRpcHandler } from "../../features/providers/AccountRpcHandler"
import { ModelCatalogRpcHandler } from "../../features/providers/ModelCatalogRpcHandler"
import { ScheduledAgentRpcHandler } from "../../features/scheduledAgents/ScheduledAgentRpcHandler"
import { InstructionSettingsRpcHandler } from "../../features/settings/InstructionSettingsRpcHandler"
import { SettingsRpcHandler } from "../../features/settings/SettingsRpcHandler"
import { TerminalRpcHandler } from "../../features/terminal/TerminalRpcHandler"
import { UiWebRpcHandler } from "../../features/web/UiWebRpcHandler"
import { WorktreeRpcHandler } from "../../features/worktrees/WorktreeRpcHandler"

type Options = Readonly<{
	settings: ConstructorParameters<typeof SettingsRpcHandler>[0]
	account: ConstructorParameters<typeof AccountRpcHandler>[0]
	browser: ConstructorParameters<typeof BrowserRpcHandler>[0]
	terminal: ConstructorParameters<typeof TerminalRpcHandler>[0]
	task: ConstructorParameters<typeof TaskRpcHandler>[0]
	checkpoint: ConstructorParameters<typeof CheckpointRpcHandler>[0]
	hook: ConstructorParameters<typeof HookRpcHandler>[0]
	scheduledAgent: ConstructorParameters<typeof ScheduledAgentRpcHandler>[0]
	worktree: ConstructorParameters<typeof WorktreeRpcHandler>[0]
	mcp: ConstructorParameters<typeof McpRpcHandler>[0]
	modelCatalog: ConstructorParameters<typeof ModelCatalogRpcHandler>[0]
	file: ConstructorParameters<typeof FileRpcHandler>[0]
	instructionSettings: ConstructorParameters<typeof InstructionSettingsRpcHandler>[0]
	uiWeb: ConstructorParameters<typeof UiWebRpcHandler>[0]
	plugin: ConstructorParameters<typeof PluginRpcHandler>[0]
}>

export function createWebviewFeatureHandlers(options: Options) {
	const instructionSettings = new InstructionSettingsRpcHandler(options.instructionSettings)
	return {
		settings: new SettingsRpcHandler(options.settings),
		account: new AccountRpcHandler(options.account),
		browser: new BrowserRpcHandler(options.browser),
		terminal: new TerminalRpcHandler(options.terminal),
		task: new TaskRpcHandler(options.task),
		checkpoint: new CheckpointRpcHandler(options.checkpoint),
		hook: new HookRpcHandler(options.hook),
		scheduledAgent: new ScheduledAgentRpcHandler(options.scheduledAgent),
		worktree: new WorktreeRpcHandler(options.worktree),
		mcp: new McpRpcHandler(options.mcp),
		modelCatalog: new ModelCatalogRpcHandler(options.modelCatalog),
		file: new FileRpcHandler({ ...options.file, refreshInstructions: (kind) => instructionSettings.refresh(kind) }),
		instructionSettings,
		uiWeb: new UiWebRpcHandler(options.uiWeb),
		plugin: new PluginRpcHandler(options.plugin),
	}
}
