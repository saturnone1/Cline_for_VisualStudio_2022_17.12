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
	let hasUserBoundary = false
	const boundaryReserve = Math.min(1_200, Math.max(300, Math.floor(maxChars * 0.25)))
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]
		if (selected.length >= RESUMED_CONVERSATION_MAX_MESSAGES && hasUserBoundary) break
		if (selected.length >= RESUMED_CONVERSATION_MAX_MESSAGES) continue

		const remaining = Math.max(0, maxChars - totalChars)
		const available = hasUserBoundary || entry.role === "User"
			? remaining
			: Math.max(0, remaining - boundaryReserve)
		if (available <= 0) continue

		const text = truncateText(entry.text, Math.min(RESUMED_CONVERSATION_MAX_ENTRY_CHARS, available))
		selected.unshift({ ...entry, text })
		totalChars += text.length
		if (entry.role === "User") hasUserBoundary = true
		if (totalChars >= maxChars && hasUserBoundary) break
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

export function buildCompactedConversationMessages(
	messages: Array<Record<string, unknown>>,
	excludeTrailingUserText = "",
) {
	const compactableMessages = withoutTrailingUserMessage(messages, excludeTrailingUserText)
	const previousCompaction = findLatestStoredCompaction(compactableMessages)
	const deltaMessages = previousCompaction ? compactableMessages.slice(previousCompaction.index + 1) : compactableMessages
	const delta = buildCompleteConversationMessages(deltaMessages)
	if (previousCompaction) {
		return [
			{ role: "context" as const, content: previousCompaction.summary },
			...delta,
		]
	}
	return delta
}

function findLatestStoredCompaction(messages: Array<Record<string, unknown>>) {
	for (let index = messages.length - 1; index >= 0; index--) {
		const contextCompaction = asRecord(messages[index].contextCompaction)
		const summary = getString(contextCompaction, "summary").trim()
		if (summary) return { index, summary }
	}
	return null
}

function withoutTrailingUserMessage(messages: Array<Record<string, unknown>>, text: string) {
	const expected = normalizeTranscriptText(text)
	if (!expected) return messages
	const copy = [...messages]
	for (let index = copy.length - 1; index >= 0; index--) {
		const entry = clineMessageToResumedTranscriptEntry(copy[index])
		if (!entry) continue
		if (entry.role === "User" && normalizeTranscriptText(entry.text) === expected) copy.splice(index, 1)
		if (entry.role === "User" || entry.role === "Assistant") break
	}
	return copy
}

function buildCompleteConversationMessages(messages: Array<Record<string, unknown>>) {
	const entries = messages
		.filter((message) => message.partial !== true)
		.map(clineMessageToResumedTranscriptEntry)
		.filter((entry): entry is { role: string; text: string } => Boolean(entry?.text))
	return entries.map((entry) => ({
		role: entry.role === "Assistant" ? "assistant" as const : "user" as const,
		content: entry.role === "Tool"
			? `Tool result:\n${entry.text}`
			: entry.role === "System"
				? `Previous session status:\n${entry.text}`
				: entry.text,
	}))
}

function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function getString(value: unknown, key: string) { const item = asRecord(value)[key]; return typeof item === "string" ? item : item == null ? "" : String(item) }
function getStringArray(value: unknown, key: string) { const item = asRecord(value)[key]; return Array.isArray(item) ? item.filter((entry): entry is string => typeof entry === "string") : [] }
function stringify(value: unknown) { if (typeof value === "string") return value; try { return JSON.stringify(value) } catch { return String(value) } }
function truncateText(value: string, maxChars: number) { return value.length <= maxChars ? value : value.slice(0, maxChars) + "\n\n[truncated " + (value.length - maxChars) + " chars]" }
