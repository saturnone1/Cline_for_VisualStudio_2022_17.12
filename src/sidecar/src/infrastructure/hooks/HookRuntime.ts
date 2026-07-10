import childProcess from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { getSettingsPath } from "../persistence/LocalAutomationStore"

export type HookLifecycleName = "TaskStart" | "TaskResume" | "TaskCancel" | "TaskComplete" | "PreToolUse" | "PostToolUse" | "UserPromptSubmit"
export type HookScript = { name: HookLifecycleName; source: "global" | "workspace"; path: string; enabled: boolean }
export type HookExecutionResult = { hook: HookScript; exitCode: number; stdout: string; stderr: string; error?: string; jsonResponse?: Record<string, unknown> }
export type PreToolUseDecision = { blocked: boolean; reason: string; inputPatch?: Record<string, unknown>; replaceInput?: boolean; validationMessage?: string; contextPatch?: Record<string, unknown>; structuredDecision?: Record<string, unknown> }

export const SUPPORTED_HOOK_NAMES: HookLifecycleName[] = [
	"TaskStart",
	"TaskResume",
	"TaskCancel",
	"TaskComplete",
	"PreToolUse",
	"PostToolUse",
	"UserPromptSubmit",
]

export function normalizeHookName(value: string): HookLifecycleName | "" {
	const normalized = String(value || "").trim()
	return SUPPORTED_HOOK_NAMES.find((name) => name.toLowerCase() === normalized.toLowerCase()) || ""
}

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

export function createHookMetadata(
	hook: HookScript,
	status: "running" | "completed" | "failed" | "cancelled",
	context: Record<string, unknown>,
	result?: { exitCode: number; stderr: string; error?: string },
	jsonResponse?: Record<string, unknown>,
) {
	const toolName = getString(context, "toolName")
	const hasJsonResponse = Boolean(jsonResponse && Object.keys(jsonResponse).length > 0)
	const decision = hookDecisionFromResponse(jsonResponse)
	return {
		hookName: hook.name,
		toolName: toolName || undefined,
		status,
		exitCode: result?.exitCode,
		hasJsonResponse,
		jsonResponse: hasJsonResponse ? jsonResponse : undefined,
		blocked: decision.blocked || undefined,
		modifiedInput: decision.inputPatch && Object.keys(decision.inputPatch).length > 0 ? true : undefined,
		replaceInput: decision.replaceInput || undefined,
		modifiedInputKeys: decision.inputPatch && Object.keys(decision.inputPatch).length > 0 ? Object.keys(decision.inputPatch) : undefined,
		validationMessage: decision.validationMessage || undefined,
		contextInjectionKeys: decision.contextPatch && Object.keys(decision.contextPatch).length > 0 ? Object.keys(decision.contextPatch) : undefined,
		structuredDecision: decision.structuredDecision && Object.keys(decision.structuredDecision).length > 0 ? decision.structuredDecision : undefined,
		reason: decision.reason || undefined,
		error:
			status === "failed"
				? {
						type: "execution",
						message: result?.error || result?.stderr || "Hook failed.",
						scriptPath: hook.path,
					}
				: undefined,
	}
}

export function extractHookJsonResponse(stdout: string): Record<string, unknown> | undefined {
	const text = String(stdout || "").trim()
	if (!text) {
		return undefined
	}

	const parsedWhole = tryParseJson(text)
	const wholeRecord = nonEmptyRecord(parsedWhole)
	if (wholeRecord) {
		return wholeRecord
	}
	if (Array.isArray(parsedWhole)) {
		for (let index = parsedWhole.length - 1; index >= 0; index--) {
			const record = nonEmptyRecord(parsedWhole[index])
			if (record) {
				return record
			}
		}
	}

	const lines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
	for (let index = lines.length - 1; index >= 0; index--) {
		const record = nonEmptyRecord(tryParseJson(lines[index]))
		if (record) {
			return record
		}
	}

	return undefined
}

export function nonEmptyRecord(value: unknown): Record<string, unknown> | undefined {
	const record = asRecord(value)
	return Object.keys(record).length > 0 ? record : undefined
}

export function hookDecisionFromResponse(response?: Record<string, unknown>): PreToolUseDecision {
	if (!response || Object.keys(response).length === 0) {
		return { blocked: false, reason: "" }
	}

	const action = (
		getString(response, "decision") ||
		getString(response, "action") ||
		getString(response, "permission") ||
		getString(response, "result") ||
		""
	).toLowerCase()
	const approved = response.approved
	const blocked =
		response.block === true ||
		response.blocked === true ||
		response.deny === true ||
		response.denied === true ||
		response.cancel === true ||
		response.cancelled === true ||
		approved === false ||
		["block", "blocked", "deny", "denied", "reject", "rejected", "cancel", "cancelled", "abort", "aborted", "disallow", "disallowed"].includes(
			action,
		)
	const reason =
		getString(response, "reason") ||
		getString(response, "message") ||
		getString(response, "error") ||
		(blocked ? "Blocked by PreToolUse hook." : "")
	const inputPatch = blocked ? undefined : getPreToolUseInputPatch(response)
	const replaceInput = inputPatch
		? response.replaceInput === true || response.replace_input === true || getString(response, "mode").toLowerCase() === "replace"
		: false
	const validationMessage =
		getString(response, "validationMessage") ||
		getString(response, "validation_message") ||
		getString(asRecord(response.validation), "message") ||
		""
	const contextPatch = blocked ? undefined : getPreToolUseContextPatch(response)
	const structuredDecision = getPreToolUseStructuredDecision(response, action)
	return { blocked, reason, inputPatch, replaceInput, validationMessage, contextPatch, structuredDecision }
}

export function getPreToolUseInputPatch(response: Record<string, unknown>) {
	for (const key of ["inputPatch", "toolInputPatch", "argumentsPatch", "paramsPatch", "input", "toolInput", "arguments", "params"]) {
		const patch = asRecord(response[key])
		if (Object.keys(patch).length > 0) {
			return patch
		}
	}
	return undefined
}

export function getPreToolUseContextPatch(response: Record<string, unknown>) {
	for (const key of ["contextPatch", "context", "contextInjection", "injectContext"]) {
		const patch = asRecord(response[key])
		if (Object.keys(patch).length > 0) {
			return patch
		}
	}
	return undefined
}

export function getPreToolUseStructuredDecision(response: Record<string, unknown>, action: string) {
	const structured = asRecord(response.structuredDecision || response.toolDecision || response.metadata)
	const result = {
		...structured,
		action: action || undefined,
		severity: getString(response, "severity") || getString(structured, "severity") || undefined,
		category: getString(response, "category") || getString(structured, "category") || undefined,
	}
	return Object.keys(result).some((key) => result[key as keyof typeof result] !== undefined && result[key as keyof typeof result] !== "")
		? result
		: undefined
}

export function mergeOptionalRecords(left?: Record<string, unknown>, right?: Record<string, unknown>) {
	if (!left || Object.keys(left).length === 0) {
		return right
	}
	if (!right || Object.keys(right).length === 0) {
		return left
	}
	return { ...left, ...right }
}

export function applyPreToolUseInputPatch(input: Record<string, unknown>, approvalRequest: Record<string, unknown>, decision: PreToolUseDecision) {
	const patch = decision.inputPatch
	if (!patch || Object.keys(patch).length === 0) {
		return
	}

	if (decision.replaceInput === true) {
		for (const key of Object.keys(input)) {
			delete input[key]
		}
	}
	Object.assign(input, patch)

	let patchedExistingRequestInput = false
	for (const key of ["input", "params", "arguments"]) {
		if (approvalRequest[key] && typeof approvalRequest[key] === "object" && !Array.isArray(approvalRequest[key])) {
			if (decision.replaceInput === true) {
				const target = approvalRequest[key] as Record<string, unknown>
				for (const existingKey of Object.keys(target)) {
					delete target[existingKey]
				}
			}
			Object.assign(approvalRequest[key] as Record<string, unknown>, input)
			patchedExistingRequestInput = true
		}
	}
	if (!patchedExistingRequestInput) {
		approvalRequest.input = input
	}
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
