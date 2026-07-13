import { normalizeAssistantTranscriptText } from "./TranscriptNormalization"
import { normalizeTranscriptText } from "./TranscriptTextPolicy"
import { tryParseJson } from "./ToolCommandFormatting"

const RESUMED_CONVERSATION_MAX_MESSAGES = 40
export const RESUMED_CONVERSATION_MAX_CHARS = 20_000
const RESUMED_CONVERSATION_MAX_ENTRY_CHARS = 2_500

export function buildResumedConversationMessages(
	messages: Array<Record<string, unknown>>,
	prompt: string,
	maxChars = RESUMED_CONVERSATION_MAX_CHARS,
) {
	const currentPrompt = prompt.trim()
	const entries = messages
		.filter((message) => message.partial !== true)
		.map(clineMessageToResumedTranscriptEntry)
		.filter((entry): entry is { role: string; text: string } => Boolean(entry?.text))

	while (entries.length > 0 && normalizeTranscriptText(entries[entries.length - 1].text) === normalizeTranscriptText(currentPrompt)) {
		entries.pop()
	}

	if (entries.length === 0 || !currentPrompt) {
		return []
	}

	const selected: Array<{ role: string; text: string }> = []
	let totalChars = currentPrompt.length
	for (let index = entries.length - 1; index >= 0 && selected.length < RESUMED_CONVERSATION_MAX_MESSAGES; index--) {
		const entry = entries[index]
		const text = truncateText(entry.text, RESUMED_CONVERSATION_MAX_ENTRY_CHARS)
		if (totalChars + text.length > maxChars) {
			if (selected.length > 0) {
				break
			}
			selected.unshift({ ...entry, text: truncateText(text, Math.max(1_000, maxChars - totalChars)) })
			break
		}
		selected.unshift({ ...entry, text })
		totalChars += text.length
	}

	while (selected.length > 0 && selected[0].role !== "User" && selected[0].role !== "Tool") {
		selected.shift()
	}

	const restored: Array<{ role: "user" | "assistant"; content: string }> = []
	for (const entry of selected) {
		const role = entry.role === "Assistant" ? "assistant" : "user"
		const content =
			entry.role === "Tool"
				? `Tool result:\n${entry.text}`
				: entry.role === "System"
					? `Previous session status:\n${entry.text}`
					: entry.text
		const previous = restored[restored.length - 1]
		if (previous?.role === role) {
			previous.content += `\n\n${content}`
		} else {
			restored.push({ role, content })
		}
	}
	return restored
}

export function clineMessageToResumedTranscriptEntry(message: Record<string, unknown>) {
	const say = getString(message, "say")
	const ask = getString(message, "ask")
	const text = resumedTranscriptTextForMessage(message)
	if (!text) {
		return null
	}

	if (say === "task" || say === "user_feedback") {
		return { role: "User", text }
	}
	if (say === "text") {
		return { role: "Assistant", text }
	}
	if (say === "tool" || say === "command_output" || say === "browser_action" || ask === "tool" || ask === "command") {
		return { role: "Tool", text }
	}
	if (ask === "followup" || ask === "plan_mode_respond" || ask === "act_mode_respond") {
		return { role: "Assistant", text }
	}
	if (say === "error" || ask === "api_req_failed") {
		return { role: "System", text }
	}
	return null
}

export function resumedTranscriptTextForMessage(message: Record<string, unknown>) {
	const say = getString(message, "say")
	const ask = getString(message, "ask")
	const text = getString(message, "text")
	if (!text || say === "completion_result" || ask === "completion_result" || say === "api_req_started" || say === "reasoning") {
		return ""
	}

	const parsed = asRecord(tryParseJson(text) ?? {})
	if (Object.keys(parsed).length === 0) {
		return normalizeAssistantTranscriptText(text)
	}

	if (ask === "command") {
		return getString(parsed, "command") || normalizeAssistantTranscriptText(text)
	}
	if (ask === "followup") {
		const question = getString(parsed, "question")
		const options = getStringArray(parsed, "options")
		return [question, options.length ? `Options: ${options.join(", ")}` : ""].filter(Boolean).join("\n")
	}
	if (say === "tool" || ask === "tool") {
		const label = getString(parsed, "tool") || getString(parsed, "path") || getString(parsed, "command") || "tool"
		const content = getString(parsed, "content") || getString(parsed, "error") || stringify(parsed)
		return `${label}\n${content}`
	}
	return normalizeAssistantTranscriptText(text)
}

function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function getString(value: unknown, key: string) { const item = asRecord(value)[key]; return typeof item === "string" ? item : item == null ? "" : String(item) }
function getStringArray(value: unknown, key: string) { const item = asRecord(value)[key]; return Array.isArray(item) ? item.filter((entry): entry is string => typeof entry === "string") : [] }
function stringify(value: unknown) { if (typeof value === "string") return value; try { return JSON.stringify(value) } catch { return String(value) } }
function truncateText(value: string, maxChars: number) { return value.length <= maxChars ? value : value.slice(0, maxChars) + "\n\n[truncated " + (value.length - maxChars) + " chars]" }
