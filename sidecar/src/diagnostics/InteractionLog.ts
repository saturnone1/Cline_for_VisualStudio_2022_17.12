import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const MAX_BYTES = 8 * 1024 * 1024
const MAX_LINE_CHARS = 96 * 1024
const MAX_STRING_CHARS = 4096
const MAX_ARRAY_ITEMS = 50
const MAX_OBJECT_KEYS = 80
const MAX_DEPTH = 8
const VERBOSE_INTERACTION_LOG = process.env.VSCLINE_VERBOSE_INTERACTION_LOG === "1"
const ENABLE_INTERACTION_LOG = VERBOSE_INTERACTION_LOG || process.env.VSCLINE_ENABLE_INTERACTION_LOG === "1"

const SENSITIVE_KEYS = [
	"apikey",
	"api_key",
	"authorization",
	"password",
	"token",
	"secret",
	"cookie",
]

export function logInteraction(direction: string, event: string, payload?: unknown) {
	try {
		if (!ENABLE_INTERACTION_LOG && !isImportantDiagnosticEvent(event)) {
			return
		}
		if (shouldSkipDefaultLog(direction, event, payload)) {
			return
		}
		const entry = {
			at: new Date().toISOString(),
			source: "sidecar",
			direction,
			event,
			payload: sanitize(compactPayload(direction, event, payload), 0),
		}
		let line = JSON.stringify(entry)
		if (line.length > MAX_LINE_CHARS) {
			line = `${line.slice(0, MAX_LINE_CHARS)}...[truncated]`
		}
		const filePath = getLogPath()
		fs.mkdirSync(path.dirname(filePath), { recursive: true })
		rotateIfNeeded(filePath)
		fs.appendFileSync(filePath, `${line}\n`, "utf8")
	} catch {
		// Diagnostics must never interfere with the extension.
	}
}

function isImportantDiagnosticEvent(event: string) {
	const normalized = event.toLowerCase()
	return normalized.includes("failed") || normalized.includes("error") || normalized.includes("slow")
}

function shouldSkipDefaultLog(direction: string, event: string, payload: unknown) {
	if (VERBOSE_INTERACTION_LOG) {
		return false
	}

	if (event === "jsonrpc.line" || event === "jsonrpc.response.result" || event === "partialMessage" || event === "taskActivity") {
		return true
	}

	if (event === "webview.postMessage" || event === "webview.message.batchItem") {
		return true
	}

	if (event.endsWith(".result") && isPostedWebviewResult(payload)) {
		return true
	}

	if (event === "sdk.event" && isHighFrequencySdkEvent(payload)) {
		return true
	}

	return false
}

function compactPayload(direction: string, event: string, payload: unknown) {
	if (event === "webview.message" && typeof payload === "string") {
		return summarizeWebviewMessage(payload)
	}

	if (event === "state.broadcast") {
		const record = asRecord(payload)
		const messages = Array.isArray(record.messages) ? record.messages : []
		return {
			count: record.count,
			messages: messages.slice(0, 4),
			truncatedMessages: Math.max(0, messages.length - 4),
		}
	}

	if (direction === "host->sidecar" && event === "webview.message.result") {
		const record = asRecord(payload)
		const webviewMessages = Array.isArray(record.webviewMessages) ? record.webviewMessages : []
		return {
			handled: record.handled,
			webviewMessageCount: webviewMessages.length,
		}
	}

	return payload
}

function summarizeWebviewMessage(rawJson: string) {
	const parsed = tryParseJson(rawJson)
	const record = asRecord(parsed)
	const request = asRecord(record.grpc_request)
	const cancel = asRecord(record.grpc_request_cancel)
	return {
		type: getString(record, "type"),
		service: getString(request, "service"),
		method: getString(request, "method"),
		requestId: getString(request, "request_id") || getString(request, "requestId") || getString(cancel, "request_id"),
		isStreaming: request.is_streaming === true || request.isStreaming === true,
		rawLength: rawJson.length,
	}
}

function isPostedWebviewResult(payload: unknown) {
	const result = asRecord(asRecord(payload).result)
	return result.posted === true && Object.keys(result).length <= 1
}

function isHighFrequencySdkEvent(payload: unknown) {
	const record = asRecord(payload)
	if (getString(record, "type") !== "agent_event") {
		return false
	}

	const event = asRecord(record.event)
	const type = getString(event, "type")
	const contentType = getString(event, "contentType")
	if ((type === "content_update" || type === "content_delta") && (contentType === "text" || contentType === "reasoning")) {
		return true
	}
	return type === "content_start" ||
		type === "content_end" ||
		type === "iteration_start" ||
		type === "iteration_end" ||
		type === "usage"
}

function getLogPath() {
	const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")
	return path.join(localAppData, "VsClineAgent", "logs", `interaction-${dateStamp()}.jsonl`)
}

function dateStamp() {
	const now = new Date()
	const year = now.getFullYear()
	const month = String(now.getMonth() + 1).padStart(2, "0")
	const day = String(now.getDate()).padStart(2, "0")
	return `${year}${month}${day}`
}

function rotateIfNeeded(filePath: string) {
	if (!fs.existsSync(filePath)) {
		return
	}
	const stat = fs.statSync(filePath)
	if (stat.size < MAX_BYTES) {
		return
	}
	const archive = `${filePath}.1`
	if (fs.existsSync(archive)) {
		fs.rmSync(archive, { force: true })
	}
	fs.renameSync(filePath, archive)
}

function sanitize(value: unknown, depth: number): unknown {
	if (value === null || value === undefined) {
		return value
	}
	if (typeof value === "string") {
		const parsed = tryParseJson(value)
		return parsed === undefined ? truncateDiagnosticString(redactSecretLikeString(value)) : sanitize(parsed, depth + 1)
	}
	if (typeof value !== "object") {
		return value
	}
	if (depth >= MAX_DEPTH) {
		return "[max-depth]"
	}
	if (Array.isArray(value)) {
		const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitize(item, depth + 1))
		return value.length > MAX_ARRAY_ITEMS ? [...items, `[truncated ${value.length - MAX_ARRAY_ITEMS} items]`] : items
	}

	const result: Record<string, unknown> = {}
	const entries = Object.entries(value as Record<string, unknown>)
	for (const [key, nested] of entries.slice(0, MAX_OBJECT_KEYS)) {
		result[key] = isSensitiveKey(key) ? redactValue(nested) : sanitize(nested, depth + 1)
	}
	if (entries.length > MAX_OBJECT_KEYS) {
		result.__truncatedKeys = entries.length - MAX_OBJECT_KEYS
	}
	return result
}

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function getString(record: Record<string, unknown>, key: string) {
	const value = record[key]
	return typeof value === "string" ? value : ""
}

function tryParseJson(value: string) {
	try {
		return JSON.parse(value) as unknown
	} catch {
		return undefined
	}
}

function isSensitiveKey(key: string) {
	const normalized = key.replace(/[-_\s]/g, "").toLowerCase()
	return SENSITIVE_KEYS.some((sensitive) => normalized.includes(sensitive.replace(/[-_\s]/g, ""))) || normalized === "key"
}

function redactValue(value: unknown) {
	const text = typeof value === "string" ? value : ""
	if (text.length <= 8) {
		return "[redacted]"
	}
	return `${text.slice(0, 4)}...${text.slice(-4)}`
}

function redactSecretLikeString(value: string) {
	return value.replace(
		/\b(sk-[A-Za-z0-9_-]{12,}|sk-proj-[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]{12,}|nvapi-[A-Za-z0-9_-]{12,})\b/g,
		(match) => `${match.slice(0, 7)}...${match.slice(-4)}`,
	)
}

function truncateDiagnosticString(value: string) {
	if (value.length <= MAX_STRING_CHARS) {
		return value
	}
	return `${value.slice(0, MAX_STRING_CHARS)}...[truncated ${value.length - MAX_STRING_CHARS} chars]`
}
