import type { AgentToolContext } from "@cline/shared"
import { readPositiveIntEnv, RUNTIME_DEFAULTS } from "../configuration/RuntimeEnvironment"

export { readPositiveIntEnv } from "../configuration/RuntimeEnvironment"

export function normalizeCommandResultForSdk(result: unknown) {
	const limit = readPositiveIntEnv("VSCLINE_SDK_COMMAND_RESULT_CHARS", 20000)
	if (typeof result === "string") return truncateText(result, limit)
	const record = asRecord(result)
	if (Object.keys(record).length === 0) return truncateText(String(result), limit)
	const stdout = typeof record.stdout === "string" ? record.stdout : undefined
	const stderr = typeof record.stderr === "string" ? record.stderr : undefined
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
	const controller = new AbortController()
	const abortSignal = (context as AgentToolContext & { abortSignal?: AbortSignal } | undefined)?.abortSignal
	const abortHandler = () => controller.abort()
	abortSignal?.addEventListener("abort", abortHandler, { once: true })
	const timer = setTimeout(() => controller.abort(), timeoutMs)
	try {
		const response = await fetch(normalizedUrl, { signal: controller.signal, headers: { Accept: "text/html,text/plain,application/json,application/xml;q=0.8,*/*;q=0.4", "User-Agent": "LIG-VS/1.0 VisualStudio2022" } })
		if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
		const contentType = response.headers.get("content-type") || ""
		const raw = await response.text()
		const text = contentType.includes("html") ? htmlToReadableText(raw) : raw
		const header = [`URL: ${normalizedUrl}`, contentType ? `Content-Type: ${contentType}` : "", prompt ? `Prompt: ${prompt}` : ""].filter(Boolean).join("\n")
		return truncateText(`${header}\n\n${text.trim()}`, maxChars)
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") throw new Error(`Web fetch timed out after ${Math.round(timeoutMs / 1000)} seconds.`)
		throw error
	} finally {
		clearTimeout(timer)
		abortSignal?.removeEventListener("abort", abortHandler)
	}
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
