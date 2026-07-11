import type { HookLifecycleName, HookScript, HookSource } from "../../application/dto/HookContracts"
import type { HookStorePort } from "../../application/ports/HookStorePort"
import { normalizeHookName } from "./HookPolicy"

export type HookMutationRequest = Readonly<{ hookName: string; source: HookSource; enabled: boolean }>

export class HookSettingsHandler {
	constructor(private readonly store: HookStorePort) {}

	scripts(workspaceRoot: string) { return this.store.list(workspaceRoot) }

	settings(workspaceRoot: string) {
		const scripts = this.scripts(workspaceRoot)
		const project = (source: HookSource) => scripts.filter((hook) => hook.source === source).map((hook) => ({ name: hook.name, enabled: hook.enabled, absolutePath: hook.path }))
		return {
			globalHooks: project("global"),
			workspaceHooks: workspaceRoot ? [{ workspaceName: this.store.workspaceName(workspaceRoot), hooks: project("workspace") }] : [],
		}
	}

	create(request: HookMutationRequest, workspaceRoot: string) {
		const hookName = requireHookName(request), source = request.source
		if (source === "workspace" && !workspaceRoot) throw new Error("No workspace is open for workspace hooks.")
		this.store.create(source, workspaceRoot, hookName)
		return this.settings(workspaceRoot)
	}

	delete(request: HookMutationRequest, workspaceRoot: string) {
		const hookName = requireHookName(request), source = request.source
		this.store.delete(source, workspaceRoot, hookName)
		return this.settings(workspaceRoot)
	}

	toggle(request: HookMutationRequest, workspaceRoot: string) {
		const hookName = requireHookName(request), source = request.source
		this.store.setEnabled(source, workspaceRoot, hookName, request.enabled)
		return this.settings(workspaceRoot)
	}
}

function requireHookName(request: HookMutationRequest) {
	const hookName = normalizeHookName(request.hookName)
	if (!hookName) throw new Error("A supported hook name is required.")
	return hookName
}
