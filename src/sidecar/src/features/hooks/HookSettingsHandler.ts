import type { HookLifecycleName, HookScript, HookSource } from "../../application/dto/HookContracts"
import type { HookStorePort } from "../../application/ports/HookStorePort"
import { normalizeHookName } from "./HookPolicy"

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

	create(message: unknown, workspaceRoot: string) {
		const request = asRecord(message), hookName = requireHookName(request), source = hookSource(request)
		if (source === "workspace" && !workspaceRoot) throw new Error("No workspace is open for workspace hooks.")
		this.store.create(source, workspaceRoot, hookName)
		return this.settings(workspaceRoot)
	}

	delete(message: unknown, workspaceRoot: string) {
		const request = asRecord(message), hookName = requireHookName(request), source = hookSource(request)
		this.store.delete(source, workspaceRoot, hookName)
		return this.settings(workspaceRoot)
	}

	toggle(message: unknown, workspaceRoot: string) {
		const request = asRecord(message), hookName = requireHookName(request), source = hookSource(request)
		this.store.setEnabled(source, workspaceRoot, hookName, request.enabled !== false)
		return this.settings(workspaceRoot)
	}
}

function requireHookName(request: Record<string, unknown>) {
	const value = readString(request.hookName) || readString(request.name)
	const hookName = normalizeHookName(value)
	if (!hookName) throw new Error("A supported hook name is required.")
	return hookName
}
function hookSource(request: Record<string, unknown>): HookSource { return request.isGlobal === true ? "global" : "workspace" }
function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function readString(value: unknown) { return typeof value === "string" ? value : "" }
