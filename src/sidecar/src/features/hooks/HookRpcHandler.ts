import type { HookSettingsHandler, HookMutationRequest } from "./HookSettingsHandler"

export type HookCommand =
	| Readonly<{ type: "refresh" }>
	| Readonly<{ type: "create"; request: HookMutationRequest }>
	| Readonly<{ type: "delete"; request: HookMutationRequest }>
	| Readonly<{ type: "toggle"; request: HookMutationRequest }>

type Callbacks = Readonly<{
	hooks: () => HookSettingsHandler
	workspaceRoot: () => Promise<string>
	enableHooks: () => void
}>

export class HookRpcHandler {
	constructor(private readonly callbacks: Callbacks) {}

	async handle(command: HookCommand) {
		const workspaceRoot = await this.callbacks.workspaceRoot()
		switch (command.type) {
			case "refresh": this.callbacks.enableHooks(); return this.callbacks.hooks().settings(workspaceRoot)
			case "create": return this.callbacks.hooks().create(command.request, workspaceRoot)
			case "delete": return this.callbacks.hooks().delete(command.request, workspaceRoot)
			case "toggle": return this.callbacks.hooks().toggle(command.request, workspaceRoot)
		}
	}
}
