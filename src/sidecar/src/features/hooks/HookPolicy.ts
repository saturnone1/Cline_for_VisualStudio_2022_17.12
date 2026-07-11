import type { HookLifecycleName } from "../../application/dto/HookContracts"

export const SUPPORTED_HOOK_NAMES: HookLifecycleName[] = ["TaskStart", "TaskResume", "TaskCancel", "TaskComplete", "PreToolUse", "PostToolUse", "UserPromptSubmit"]

export function normalizeHookName(value: string): HookLifecycleName | "" {
	const normalized = String(value || "").trim()
	return SUPPORTED_HOOK_NAMES.find((name) => name.toLowerCase() === normalized.toLowerCase()) || ""
}

export type PreToolUseDecision = { blocked: boolean; reason: string; inputPatch?: Record<string, unknown>; replaceInput?: boolean; validationMessage?: string; contextPatch?: Record<string, unknown>; structuredDecision?: Record<string, unknown> }

export function extractHookJsonResponse(stdout: string): Record<string, unknown> | undefined {
	const text = String(stdout || "").trim()
	if (!text) return undefined
	const parsedWhole = tryParseJson(text)
	const wholeRecord = nonEmptyRecord(parsedWhole)
	if (wholeRecord) return wholeRecord
	if (Array.isArray(parsedWhole)) {
		for (let index = parsedWhole.length - 1; index >= 0; index--) {
			const record = nonEmptyRecord(parsedWhole[index]); if (record) return record
		}
	}
	const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
	for (let index = lines.length - 1; index >= 0; index--) {
		const record = nonEmptyRecord(tryParseJson(lines[index])); if (record) return record
	}
	return undefined
}

export function hookDecisionFromResponse(response?: Record<string, unknown>): PreToolUseDecision {
	if (!response || Object.keys(response).length === 0) return { blocked: false, reason: "" }
	const action = (readString(response.decision) || readString(response.action) || readString(response.permission) || readString(response.result)).toLowerCase()
	const blocked = response.block === true || response.blocked === true || response.deny === true || response.denied === true || response.cancel === true || response.cancelled === true || response.approved === false || ["block", "blocked", "deny", "denied", "reject", "rejected", "cancel", "cancelled", "abort", "aborted", "disallow", "disallowed"].includes(action)
	const reason = readString(response.reason) || readString(response.message) || readString(response.error) || (blocked ? "Blocked by PreToolUse hook." : "")
	const inputPatch = blocked ? undefined : firstRecord(response, ["inputPatch", "toolInputPatch", "argumentsPatch", "paramsPatch", "input", "toolInput", "arguments", "params"])
	const replaceInput = inputPatch ? response.replaceInput === true || response.replace_input === true || readString(response.mode).toLowerCase() === "replace" : false
	const validationMessage = readString(response.validationMessage) || readString(response.validation_message) || readString(asRecord(response.validation).message)
	const contextPatch = blocked ? undefined : firstRecord(response, ["contextPatch", "context", "contextInjection", "injectContext"])
	const structured = asRecord(response.structuredDecision || response.toolDecision || response.metadata)
	const structuredResult = { ...structured, action: action || undefined, severity: readString(response.severity) || readString(structured.severity) || undefined, category: readString(response.category) || readString(structured.category) || undefined }
	const structuredDecision = Object.values(structuredResult).some((value) => value !== undefined && value !== "") ? structuredResult : undefined
	return { blocked, reason, inputPatch, replaceInput, validationMessage, contextPatch, structuredDecision }
}

export function mergeOptionalRecords(left?: Record<string, unknown>, right?: Record<string, unknown>) {
	if (!left || Object.keys(left).length === 0) return right
	if (!right || Object.keys(right).length === 0) return left
	return { ...left, ...right }
}

export function applyPreToolUseInputPatch(input: Record<string, unknown>, approvalRequest: Record<string, unknown>, decision: PreToolUseDecision) {
	const patch = decision.inputPatch
	if (!patch || Object.keys(patch).length === 0) return
	if (decision.replaceInput === true) for (const key of Object.keys(input)) delete input[key]
	Object.assign(input, patch)
	let patched = false
	for (const key of ["input", "params", "arguments"]) {
		const target = asRecord(approvalRequest[key])
		if (Object.keys(target).length === 0 && (!approvalRequest[key] || typeof approvalRequest[key] !== "object")) continue
		if (decision.replaceInput === true) for (const existingKey of Object.keys(target)) delete target[existingKey]
		Object.assign(target, input); patched = true
	}
	if (!patched) approvalRequest.input = input
}

function firstRecord(source: Record<string, unknown>, keys: string[]) { for (const key of keys) { const value = nonEmptyRecord(source[key]); if (value) return value } return undefined }
function nonEmptyRecord(value: unknown) { const record = asRecord(value); return Object.keys(record).length > 0 ? record : undefined }
function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function readString(value: unknown) { return typeof value === "string" ? value : "" }
function tryParseJson(value: string) { try { return JSON.parse(value) } catch { return undefined } }
