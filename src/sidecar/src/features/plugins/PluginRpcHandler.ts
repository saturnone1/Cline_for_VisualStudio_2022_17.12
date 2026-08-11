export type PluginCommand = Readonly<{ type: "list" }>

type Callbacks = Readonly<{
	workspaceRoot: () => Promise<string>
	discover: (workspaceRoot: string) => Array<Record<string, unknown>>
}>

export class PluginRpcHandler {
	constructor(private readonly callbacks: Callbacks) {}

	async handle(_command: PluginCommand) {
		const workspaceRoot = await this.callbacks.workspaceRoot().catch(() => "")
		const plugins = this.callbacks.discover(workspaceRoot)
		return { success: true, supported: true, plugins, items: plugins, count: plugins.length, workspaceRoot, marketplaceEnabled: false, marketplaceInstallSupported: false, marketplaceDisabledReason: "Air-gap Visual Studio mode only discovers local plugin configuration; online marketplace install is intentionally disabled." }
	}
}
