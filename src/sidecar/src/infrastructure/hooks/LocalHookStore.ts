import fs from "node:fs"
import path from "node:path"
import type { HookLifecycleName, HookScript, HookSource } from "../../application/dto/HookContracts"
import type { HookStorePort } from "../../application/ports/HookStorePort"
import { normalizeHookName } from "../../features/hooks/HookPolicy"
import { createHookScriptTemplate, findHookScript, getGlobalHooksDirectory, getHookToggle, getWorkspaceHooksDirectory, isExecutableHookFile, removeHookToggle, safeReadDirFiles, setHookToggle } from "./HookRuntime"

export class LocalHookStore implements HookStorePort {
	list(workspaceRoot: string) {
		const scripts: HookScript[] = []
		for (const source of ["global", "workspace"] as const) {
			const directory = this.directory(source, workspaceRoot)
			if (!directory || !fs.existsSync(directory)) continue
			for (const filePath of safeReadDirFiles(directory)) {
				const hookName = normalizeHookName(path.basename(filePath, path.extname(filePath)))
				if (hookName && isExecutableHookFile(filePath)) scripts.push({ name: hookName, source, path: filePath, enabled: getHookToggle(source, workspaceRoot, hookName) })
			}
		}
		return scripts.sort((left, right) => `${left.source}:${left.name}`.localeCompare(`${right.source}:${right.name}`))
	}

	create(source: HookSource, workspaceRoot: string, hookName: HookLifecycleName) {
		const directory = this.directory(source, workspaceRoot)
		if (!directory) throw new Error("No workspace is open for workspace hooks.")
		fs.mkdirSync(directory, { recursive: true })
		const hookPath = findHookScript(directory, hookName)?.path || path.join(directory, `${hookName}.ps1`)
		if (!fs.existsSync(hookPath)) fs.writeFileSync(hookPath, createHookScriptTemplate(hookName), "utf8")
		setHookToggle(source, workspaceRoot, hookName, true)
	}

	delete(source: HookSource, workspaceRoot: string, hookName: HookLifecycleName) {
		const directory = this.directory(source, workspaceRoot), existing = directory ? findHookScript(directory, hookName) : null
		if (existing) fs.rmSync(existing.path, { force: true })
		removeHookToggle(source, workspaceRoot, hookName)
	}

	setEnabled(source: HookSource, workspaceRoot: string, hookName: HookLifecycleName, enabled: boolean) { setHookToggle(source, workspaceRoot, hookName, enabled) }
	workspaceName(workspaceRoot: string) { return path.basename(workspaceRoot) }
	private directory(source: HookSource, workspaceRoot: string) { return source === "global" ? getGlobalHooksDirectory() : getWorkspaceHooksDirectory(workspaceRoot) }
}
