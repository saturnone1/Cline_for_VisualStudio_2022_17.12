import type { HookLifecycleName, HookScript, HookSource } from "../dto/HookContracts"

export interface HookStorePort {
	list(workspaceRoot: string): HookScript[]
	create(source: HookSource, workspaceRoot: string, hookName: HookLifecycleName): void
	delete(source: HookSource, workspaceRoot: string, hookName: HookLifecycleName): void
	setEnabled(source: HookSource, workspaceRoot: string, hookName: HookLifecycleName, enabled: boolean): void
	workspaceName(workspaceRoot: string): string
}
