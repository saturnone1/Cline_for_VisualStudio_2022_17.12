import childProcess from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { getSettingsPath } from "../persistence/LocalAutomationStore"
import { normalizeHookName } from "../../features/hooks/HookPolicy"
export { SUPPORTED_HOOK_NAMES, normalizeHookName } from "../../features/hooks/HookPolicy"
import type { HookExecutionResult, HookLifecycleName, HookScript } from "../../application/dto/HookContracts"
export type { HookExecutionResult, HookLifecycleName, HookScript } from "../../application/dto/HookContracts"

export function getGlobalHooksDirectory() {
	const userProfile = process.env.USERPROFILE || process.env.HOME || process.cwd()
	return path.join(userProfile, ".cline", "hooks")
}

export function getWorkspaceHooksDirectory(workspaceRoot: string) {
	return workspaceRoot ? path.join(workspaceRoot, ".clinerules", "hooks") : ""
}

export function safeReadDirFiles(directory: string) {
	try {
		return fs
			.readdirSync(directory, { withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => path.join(directory, entry.name))
	} catch {
		return []
	}
}

export function isExecutableHookFile(filePath: string) {
	return [".ps1", ".cmd", ".bat", ".js"].includes(path.extname(filePath).toLowerCase())
}

export function findHookScript(directory: string, hookName: HookLifecycleName) {
	return safeReadDirFiles(directory)
		.map((filePath) => ({ name: normalizeHookName(path.basename(filePath, path.extname(filePath))), path: filePath }))
		.find((item) => item.name === hookName && isExecutableHookFile(item.path))
}

export function createHookScriptTemplate(hookName: string) {
	return [
		'$ErrorActionPreference = "Stop"',
		`# ${hookName} hook`,
		"# Hook context is available as JSON in $env:VSCLINE_HOOK_CONTEXT and stdin.",
		"$contextJson = $env:VSCLINE_HOOK_CONTEXT",
		'Write-Output "Hook executed: ' + hookName + '"',
		"",
	].join("\r\n")
}

export function getHookToggleStorePath() {
	return path.join(path.dirname(getSettingsPath()), "hook-toggles.json")
}

export function readHookToggleStore() {
	try {
		return JSON.parse(fs.readFileSync(getHookToggleStorePath(), "utf8")) as Record<string, unknown>
	} catch {
		return {}
	}
}

export function writeHookToggleStore(store: Record<string, unknown>) {
	fs.mkdirSync(path.dirname(getHookToggleStorePath()), { recursive: true })
	fs.writeFileSync(getHookToggleStorePath(), JSON.stringify(store, null, 2), "utf8")
}

export function normalizeHookWorkspaceKey(workspaceRoot: string) {
	try {
		return path.resolve(workspaceRoot || "").toLowerCase()
	} catch {
		return String(workspaceRoot || "").toLowerCase()
	}
}

export function hookToggleKey(source: "global" | "workspace", workspaceRoot: string, hookName: string) {
	return source === "global" ? `global:${hookName}` : `workspace:${normalizeHookWorkspaceKey(workspaceRoot)}:${hookName}`
}

export function getHookToggle(source: "global" | "workspace", workspaceRoot: string, hookName: string) {
	const store = readHookToggleStore()
	const value = store[hookToggleKey(source, workspaceRoot, hookName)]
	return typeof value === "boolean" ? value : true
}

export function setHookToggle(source: "global" | "workspace", workspaceRoot: string, hookName: string, enabled: boolean) {
	const store = readHookToggleStore()
	store[hookToggleKey(source, workspaceRoot, hookName)] = enabled
	writeHookToggleStore(store)
}

export function removeHookToggle(source: "global" | "workspace", workspaceRoot: string, hookName: string) {
	const store = readHookToggleStore()
	delete store[hookToggleKey(source, workspaceRoot, hookName)]
	writeHookToggleStore(store)
}

export async function executeHookScript(hook: HookScript, context: Record<string, unknown>) {
	const extension = path.extname(hook.path).toLowerCase()
	const contextJson = JSON.stringify(context)
	const cwd = getString(context, "workspaceRoot") || process.cwd()
	const timeoutMs = readPositiveIntEnv("VSCLINE_HOOK_TIMEOUT_MS", 30000)
	const outputLimit = readPositiveIntEnv("VSCLINE_HOOK_OUTPUT_CHARS", 12000)
	const command =
		extension === ".ps1"
			? "powershell.exe"
			: extension === ".js"
				? "node.exe"
				: "cmd.exe"
	const args =
		extension === ".ps1"
			? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", hook.path]
			: extension === ".js"
				? [hook.path]
				: ["/c", hook.path]

	return new Promise<{ exitCode: number; stdout: string; stderr: string; error?: string }>((resolve) => {
		let stdout = ""
		let stderr = ""
		let settled = false
		const child = childProcess.spawn(command, args, {
			cwd,
			env: {
				...process.env,
				VSCLINE_HOOK_CONTEXT: contextJson,
				VSCLINE_HOOK_NAME: hook.name,
				VSCLINE_HOOK_SOURCE: hook.source,
				VSCLINE_HOOK_SCRIPT: hook.path,
			},
			windowsHide: true,
		})

		const timer = setTimeout(() => {
			if (settled) {
				return
			}
			settled = true
			child.kill()
			resolve({
				exitCode: -1,
				stdout: truncateText(stdout, outputLimit),
				stderr: truncateText(stderr, outputLimit),
				error: `Hook timed out after ${Math.round(timeoutMs / 1000)} seconds.`,
			})
		}, timeoutMs)

		child.stdout?.on("data", (chunk) => {
			stdout = truncateText(stdout + chunk.toString(), outputLimit)
		})
		child.stderr?.on("data", (chunk) => {
			stderr = truncateText(stderr + chunk.toString(), outputLimit)
		})
		child.on("error", (error) => {
			if (settled) {
				return
			}
			settled = true
			clearTimeout(timer)
			resolve({ exitCode: -1, stdout, stderr, error: error.message })
		})
		child.on("close", (code) => {
			if (settled) {
				return
			}
			settled = true
			clearTimeout(timer)
			resolve({ exitCode: code ?? 0, stdout: truncateText(stdout, outputLimit), stderr: truncateText(stderr, outputLimit) })
		})
		child.stdin?.end(contextJson)
	})
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function getString(record: Record<string, unknown>, key: string) {
	const value = record[key]
	return typeof value === "string" ? value : value == null ? "" : String(value)
}
function tryParseJson(value: string) {
	try { return JSON.parse(value) as unknown } catch { return undefined }
}
function readPositiveIntEnv(name: string, fallback: number) {
	const value = Number(process.env[name])
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}
function truncateText(value: string, maxChars: number) {
	return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n\n[truncated ${value.length - maxChars} chars]`
}
