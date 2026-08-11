import type { AgentToolContext } from "@cline/shared"
import { readPositiveIntEnv, RUNTIME_DEFAULTS } from "../configuration/RuntimeEnvironment"
import { BoundedFetchError, fetchBoundedText } from "../network/BoundedFetch"

export { readPositiveIntEnv } from "../configuration/RuntimeEnvironment"

export function normalizeCommandResultForSdk(result: unknown, outputLineLimit?: number) {
	const limit = readPositiveIntEnv("VSCLINE_SDK_COMMAND_RESULT_CHARS", 20000)
	if (typeof result === "string") return truncateText(result, limit)
	const record = asRecord(result)
	if (Object.keys(record).length === 0) return truncateText(String(result), limit)
	const lineLimit = Number.isFinite(outputLineLimit) && Number(outputLineLimit) > 0 ? Math.round(Number(outputLineLimit)) : undefined
	const stdout = typeof record.stdout === "string" ? boundOutputLines(record.stdout, lineLimit) : undefined
	const stderr = typeof record.stderr === "string" ? boundOutputLines(record.stderr, lineLimit) : undefined
	const backgroundNote = record.background === true
		? `Command is still running in the Visual Studio terminal session (${stringValue(record.terminalId) || "terminal"}). Use terminal state/output if more output is needed.`
		: undefined
	return JSON.stringify({
		...record,
		stdout: stdout === undefined ? backgroundNote : truncateText([backgroundNote, stdout].filter(Boolean).join("\n"), limit),
		stderr: stderr === undefined ? undefined : truncateText(stderr, Math.min(limit, 8000)),
	})
}

export async function fetchWebContentForSdk(url: string, prompt: string, context?: AgentToolContext) {
	const normalizedUrl = normalizeHttpUrl(url)
	if (!normalizedUrl) throw new Error(`Invalid URL for fetch_web_content: ${url}`)
	const timeoutMs = readPositiveIntEnv("VSCLINE_WEB_FETCH_TIMEOUT_MS", RUNTIME_DEFAULTS.webFetchTimeoutMs)
	const maxChars = readPositiveIntEnv("VSCLINE_WEB_FETCH_RESULT_CHARS", 20000)
	const maximumBytes = readPositiveIntEnv("VSCLINE_WEB_FETCH_MAXIMUM_BYTES", 2_000_000)
	const abortSignal = context?.signal ?? (context as AgentToolContext & { abortSignal?: AbortSignal } | undefined)?.abortSignal
	try {
		const { response, text: raw } = await fetchBoundedText(normalizedUrl, {
			headers: { Accept: "text/html,text/plain,application/json,application/xml;q=0.8,*/*;q=0.4", "User-Agent": "LIG-VS/1.0 VisualStudio2022" },
		}, { timeoutMs, maximumBytes, signal: abortSignal })
		if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
		const contentType = response.headers.get("content-type") || ""
		const text = contentType.includes("html") ? htmlToReadableText(raw) : raw
		const header = [`URL: ${normalizedUrl}`, contentType ? `Content-Type: ${contentType}` : "", prompt ? `Prompt: ${prompt}` : ""].filter(Boolean).join("\n")
		return truncateText(`${header}\n\n${text.trim()}`, maxChars)
	} catch (error) {
		if (error instanceof BoundedFetchError) throw new Error(`Web fetch failed: ${error.message}`)
		throw error
	}
}

function boundOutputLines(value: string, maximumLines?: number) {
	if (!maximumLines) return value
	const lines = value.split(/\r?\n/)
	if (lines.length <= maximumLines) return value
	const headCount = Math.ceil(maximumLines / 2)
	const tailCount = Math.floor(maximumLines / 2)
	return [
		...lines.slice(0, headCount),
		`[${lines.length - maximumLines} output lines omitted]`,
		...lines.slice(lines.length - tailCount),
	].join("\n")
}

export function normalizeHttpUrl(value: string) {
	const raw = String(value || "").trim()
	if (!raw) return ""
	if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https?:\/\//i.test(raw)) return ""
	try {
		const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
		return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : ""
	} catch { return "" }
}

export function htmlToReadableText(html: string) {
	return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
		.replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6])>/gi, "\n").replace(/<br\s*\/?>/gi, "\n")
		.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
		.replace(/[ \t]+/g, " ").replace(/\n\s+/g, "\n").replace(/\n{3,}/g, "\n\n")
}

function truncateText(value: string, maxChars: number) {
	return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n[truncated ${value.length - maxChars} chars]`
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringValue(value: unknown) {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined
}
