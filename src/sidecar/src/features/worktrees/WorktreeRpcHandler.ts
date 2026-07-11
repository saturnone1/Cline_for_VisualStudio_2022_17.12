import type { WorktreeMutationHandler, CreateWorktreeRequest, DeleteWorktreeRequest, MergeWorktreeRequest, RecoverWorktreeRequest, SwitchWorktreeRequest } from "./WorktreeMutationHandler"
import type { WorktreeQueryHandler } from "./WorktreeQueryHandler"

export type WorktreeCommand =
	| Readonly<{ type: "list" }>
	| Readonly<{ type: "defaults" }>
	| Readonly<{ type: "includeStatus" }>
	| Readonly<{ type: "createInclude"; content: string }>
	| Readonly<{ type: "create"; request: CreateWorktreeRequest }>
	| Readonly<{ type: "switch"; request: SwitchWorktreeRequest }>
	| Readonly<{ type: "merge"; request: MergeWorktreeRequest }>
	| Readonly<{ type: "recover"; request: RecoverWorktreeRequest }>
	| Readonly<{ type: "delete"; request: DeleteWorktreeRequest }>
	| Readonly<{ type: "trackOpened" }>

type Callbacks = Readonly<{
	queries: () => WorktreeQueryHandler
	mutations: () => WorktreeMutationHandler
	workspaceRoot: () => Promise<string>
	setFeatureEnabled: (enabled: boolean) => void
}>

export class WorktreeRpcHandler {
	constructor(private readonly callbacks: Callbacks) {}

	async handle(command: WorktreeCommand): Promise<unknown> {
		const queries = this.callbacks.queries(), mutations = this.callbacks.mutations()
		switch (command.type) {
			case "list": {
				const result = await queries.listWorktrees(await this.callbacks.workspaceRoot())
				this.callbacks.setFeatureEnabled(result.isGitRepo && !result.error)
				return result
			}
			case "defaults": return queries.getDefaults(await this.callbacks.workspaceRoot())
			case "includeStatus": return queries.getIncludeStatus(await this.callbacks.workspaceRoot())
			case "createInclude": return queries.createInclude(command.content, await this.callbacks.workspaceRoot())
			case "create": return mutations.create(command.request, await this.callbacks.workspaceRoot())
			case "switch": return mutations.switch(command.request)
			case "merge": return mutations.merge(command.request, await this.callbacks.workspaceRoot())
			case "recover": return mutations.recover(command.request)
			case "delete": return mutations.delete(command.request, await this.callbacks.workspaceRoot())
			case "trackOpened": return { success: true }
		}
	}
}
