import { ClineMessage } from "./ExtensionMessage"

export interface ContextWindowUsage {
	used: number
	source: "reported" | "estimated"
	reliable: boolean
}

const MAX_ESTIMATED_TEXT_CHARS_PER_MESSAGE = 64_000
const MAX_ESTIMATED_FILE_TOKENS_PER_MESSAGE = 1_000

/** Returns the raw token count from the latest completed API request. */
export function getLastApiReqTotalTokens(messages: ClineMessage[]): number {
	const snapshot = findLatestReportedUsage(messages)
	if (!snapshot || messages.slice(snapshot.index + 1).some(advancesModelContext)) {
		return 0
	}
	return snapshot.used
}

export function getContextWindowUsage(messages: ClineMessage[]): ContextWindowUsage | undefined {
	const currentContextMessages = getCurrentContextMessages(messages)
	const snapshot = findLatestReportedUsage(currentContextMessages)
	if (snapshot) {
		const reported = getCalibratedConversationUsage(currentContextMessages, snapshot)
		const afterSnapshot = currentContextMessages.slice(snapshot.index + 1)
		const firstNewContextIndex = afterSnapshot.findIndex(advancesModelContext)
		if (firstNewContextIndex < 0) {
			return { used: reported, source: "estimated", reliable: false }
		}

		const incremental = estimateConversationTokens(afterSnapshot.slice(firstNewContextIndex))
		return {
			used: reported + incremental,
			source: "estimated",
			reliable: false,
		}
	}

	const estimated = estimateConversationTokens(currentContextMessages)
	return estimated > 0 ? { used: estimated, source: "estimated", reliable: false } : undefined
}

type ReportedUsageSnapshot = { index: number; promptTokens: number; outputTokens: number; used: number }

function findLatestReportedUsage(messages: ClineMessage[]): ReportedUsageSnapshot | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]
		if (message.type !== "say" || message.say !== "api_req_started" || !message.text) {
			continue
		}

		try {
			const usage = JSON.parse(message.text) as Record<string, unknown>
			if (usage.usageReliable === false) return undefined
			const input = firstTokenCount(usage, ["tokensIn", "inputTokens", "promptTokens"])
			const output = firstTokenCount(usage, ["tokensOut", "outputTokens", "completionTokens"])
			const cacheReads = firstTokenCount(usage, ["cacheReads", "cacheReadTokens", "cache_read_input_tokens"])
			const cacheWrites = firstTokenCount(usage, ["cacheWrites", "cacheWriteTokens", "cache_creation_input_tokens"])
			const promptTokens = input + cacheReads + cacheWrites
			if (promptTokens > 0) {
				return { index: i, promptTokens, outputTokens: output, used: promptTokens + output }
			}
			return undefined
		} catch {
			return undefined
		}
	}
	return undefined
}

function getCalibratedConversationUsage(messages: ClineMessage[], latest: ReportedUsageSnapshot) {
	const first = findFirstReportedUsage(messages)
	if (!first) return latest.used

	const initialUserContext = estimateConversationTokens(
		messages.slice(0, first.index).filter(advancesModelContext),
	)
	const fixedPromptOverhead = Math.max(0, first.promptTokens - initialUserContext)
	const calibratedReported = latest.promptTokens >= fixedPromptOverhead
		? latest.promptTokens - fixedPromptOverhead + latest.outputTokens
		: latest.used
	const visibleConversation = estimateConversationTokens(messages)
	return Math.max(1, calibratedReported, visibleConversation)
}

function findFirstReportedUsage(messages: ClineMessage[]): ReportedUsageSnapshot | undefined {
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i]
		if (message.type !== "say" || message.say !== "api_req_started" || !message.text) continue
		try {
			const usage = JSON.parse(message.text) as Record<string, unknown>
			if (usage.usageReliable === false) continue
			const input = firstTokenCount(usage, ["tokensIn", "inputTokens", "promptTokens"])
			const output = firstTokenCount(usage, ["tokensOut", "outputTokens", "completionTokens"])
			const cacheReads = firstTokenCount(usage, ["cacheReads", "cacheReadTokens", "cache_read_input_tokens"])
			const cacheWrites = firstTokenCount(usage, ["cacheWrites", "cacheWriteTokens", "cache_creation_input_tokens"])
			const promptTokens = input + cacheReads + cacheWrites
			if (promptTokens > 0) return { index: i, promptTokens, outputTokens: output, used: promptTokens + output }
		} catch {
			// Continue to the next valid snapshot.
		}
	}
	return undefined
}

export function getCurrentContextMessages(messages: ClineMessage[]): ClineMessage[] {
	const compactBoundaryIndex = findLastSuccessfulCompactionBoundaryIndex(messages)
	if (compactBoundaryIndex < 0) {
		return messages
	}

	const scopedMessages = messages.slice(compactBoundaryIndex + 1)
	return scopedMessages.length > 0 ? scopedMessages : messages.slice(compactBoundaryIndex)
}

export function estimateConversationTokens(messages: ClineMessage[]): number {
	return messages.reduce((total, message) => {
		if (isInternalUsageMetadata(message)) {
			return total
		}
		if (isEmptyJsonNoise(message.text) && !message.reasoning && !message.files?.length && !message.images?.length) {
			return total
		}

		const text = [message.text, message.reasoning].filter(Boolean).join("\n")
		const textTokens = estimateTextTokens(limitEstimatedText(text))
		const fileTokens = Math.min(
			estimateTextTokens((message.files ?? []).join("\n")),
			MAX_ESTIMATED_FILE_TOKENS_PER_MESSAGE,
		)
		const imageTokens = (message.images?.length ?? 0) * 85
		return total + textTokens + fileTokens + imageTokens + 12
	}, 0)
}

function advancesModelContext(message: ClineMessage) {
	if (message.type === "ask") {
		return message.ask === "tool" || message.ask === "command" || message.ask === "command_output" || message.ask === "use_mcp_server"
	}
	return message.say === "task" || message.say === "user_feedback" || message.say === "user_feedback_diff" || message.say === "tool" || message.say === "command_output"
}

function isInternalUsageMetadata(message: ClineMessage) {
	return message.type === "say" && (
		message.say === "api_req_started" ||
		message.say === "api_req_finished" ||
		message.say === "deleted_api_reqs" ||
		message.say === "subagent_usage" ||
		message.say === "task_progress"
	)
}

function firstTokenCount(usage: Record<string, unknown>, keys: string[]): number {
	for (const key of keys) {
		const value = usage[key]
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
			return value
		}
	}
	return 0
}

function limitEstimatedText(text: string): string {
	return text.length <= MAX_ESTIMATED_TEXT_CHARS_PER_MESSAGE
		? text
		: text.slice(0, MAX_ESTIMATED_TEXT_CHARS_PER_MESSAGE)
}

function isEmptyJsonNoise(text?: string) {
	return text?.trim() === "{}"
}

function estimateTextTokens(text: string): number {
	const normalized = text.trim()
	if (!normalized) {
		return 0
	}

	let cjkChars = 0
	let wordChars = 0
	let symbols = 0
	for (const char of normalized) {
		const codePoint = char.codePointAt(0) ?? 0
		if (isCjkCodePoint(codePoint)) {
			cjkChars++
		} else if (isWhitespaceCodePoint(codePoint)) {
			continue
		} else if (isWordCodePoint(codePoint)) {
			wordChars++
		} else {
			symbols++
		}
	}

	// Code, JSON and tool payload punctuation tokenize more densely than prose.
	return Math.ceil(cjkChars + wordChars / 4 + symbols / 2)
}

function isWordCodePoint(codePoint: number) {
	return (
		(codePoint >= 0x30 && codePoint <= 0x39) ||
		(codePoint >= 0x41 && codePoint <= 0x5a) ||
		(codePoint >= 0x61 && codePoint <= 0x7a) ||
		codePoint === 0x5f
	)
}

function isCjkCodePoint(codePoint: number) {
	return (
		(codePoint >= 0x3040 && codePoint <= 0x30ff) ||
		(codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
		(codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
		(codePoint >= 0xf900 && codePoint <= 0xfaff) ||
		(codePoint >= 0xac00 && codePoint <= 0xd7af)
	)
}

function isWhitespaceCodePoint(codePoint: number) {
	return (
		codePoint === 0x09 ||
		codePoint === 0x0a ||
		codePoint === 0x0b ||
		codePoint === 0x0c ||
		codePoint === 0x0d ||
		codePoint === 0x20 ||
		codePoint === 0x85 ||
		codePoint === 0xa0 ||
		codePoint === 0x1680 ||
		(codePoint >= 0x2000 && codePoint <= 0x200a) ||
		codePoint === 0x2028 ||
		codePoint === 0x2029 ||
		codePoint === 0x202f ||
		codePoint === 0x205f ||
		codePoint === 0x3000
	)
}

function isContextCompactionBoundaryMessage(message: ClineMessage): boolean {
	if (message.type !== "say" || message.say !== "reasoning") {
		return false
	}
	const text = [message.text, message.reasoning].filter(Boolean).join("\n").toLowerCase()
	return text.includes("컨텍스트 압축 중") || text.includes("compacting context")
}

function findLastSuccessfulCompactionBoundaryIndex(messages: ClineMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (isContextCompactionBoundaryMessage(messages[i]) && hasAssistantTextAfterIndex(messages, i)) {
			return i
		}
	}
	return -1
}

function hasAssistantTextAfterIndex(messages: ClineMessage[], index: number): boolean {
	return messages.slice(index + 1).some((message) =>
		message.type === "say" && message.say === "text" && !!message.text?.trim(),
	)
}
