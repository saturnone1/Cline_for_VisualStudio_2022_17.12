import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const MAX_BYTES = 8 * 1024 * 1024
const MAX_LINE_CHARS = 96 * 1024
const MAX_STRING_CHARS = 4096
const MAX_ARRAY_ITEMS = 50
const MAX_OBJECT_KEYS = 80
const MAX_DEPTH = 8

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
		const entry = {
			at: new Date().toISOString(),
			source: "sidecar",
			direction,
			event,
			payload: sanitize(payload, 0),
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
