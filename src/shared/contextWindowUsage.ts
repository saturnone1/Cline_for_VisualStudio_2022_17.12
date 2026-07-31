import { ClineMessage } from "./ExtensionMessage"

export interface ContextWindowUsage {
	used: number
	source: "reported" | "estimated"
	reliable: boolean
	sdkMaxInputTokens?: number
	sdkCompactionTriggerTokens?: number
	sdkCompactionTargetTokens?: number
}

const MAX_ESTIMATED_TEXT_CHARS_PER_MESSAGE = 64_000
const MAX_ESTIMATED_FILE_TOKENS_PER_MESSAGE = 1_000
const messageTokenCache = new WeakMap<ClineMessage, number>()

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
	const compactedBaseline = getLastCompactedTokenBaseline(messages)
	const sdkBudget = getLatestSdkCompactionBudget(messages)
	const snapshot = findLatestReportedUsage(currentContextMessages)
	if (snapshot) {
		const afterSnapshot = currentContextMessages.slice(snapshot.index + 1)
		const firstNewContextIndex = afterSnapshot.findIndex(advancesModelContext)
		if (firstNewContextIndex < 0) {
			return { used: snapshot.used, source: "reported", reliable: true, ...sdkBudget }
		}

		const incremental = estimateConversationTokens(afterSnapshot.slice(firstNewContextIndex))
		return {
			used: snapshot.used + incremental,
			source: "estimated",
			reliable: false,
			...sdkBudget,
		}
	}

	const estimated = compactedBaseline + estimateConversationTokens(currentContextMessages)
	return estimated > 0 ? { used: estimated, source: "estimated", reliable: false, ...sdkBudget } : undefined
}

function getLatestSdkCompactionBudget(messages: ClineMessage[]) {
	for (let index = messages.length - 1; index >= 0; index--) {
		const compaction = messages[index].contextCompaction
		if (!compaction) continue
		const sdkMaxInputTokens = positiveCount(compaction.maxInputTokens)
		const sdkCompactionTriggerTokens = positiveCount(compaction.triggerTokens)
		const sdkCompactionTargetTokens = positiveCount(compaction.targetTokens)
		if (sdkMaxInputTokens || sdkCompactionTriggerTokens || sdkCompactionTargetTokens) {
			return {
				...(sdkMaxInputTokens ? { sdkMaxInputTokens } : {}),
				...(sdkCompactionTriggerTokens ? { sdkCompactionTriggerTokens } : {}),
				...(sdkCompactionTargetTokens ? { sdkCompactionTargetTokens } : {}),
			}
		}
	}
	return {}
}

function positiveCount(value: unknown) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined
}

function getLastCompactedTokenBaseline(messages: ClineMessage[]) {
	for (let index = messages.length - 1; index >= 0; index--) {
		const value = messages[index].contextCompaction?.estimatedTokensAfter
		if (typeof value === "number" && Number.isFinite(value) && value > 0) return value
	}
	return 0
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
			// SDK inputTokens is the complete prompt count. Cache counters are a
			// breakdown of that total, not additional context. Older integrations
			// sometimes reported only the breakdown, so retain it as a fallback.
			const promptTokens = input > 0 ? input : cacheReads + cacheWrites
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

export function getCurrentContextMessages(messages: ClineMessage[]): ClineMessage[] {
	const compactBoundaryIndex = findLastSuccessfulCompactionBoundaryIndex(messages)
	if (compactBoundaryIndex < 0) {
		return messages
	}

	const scopedMessages = messages.slice(compactBoundaryIndex + 1)
	return scopedMessages.length > 0 ? scopedMessages : messages.slice(compactBoundaryIndex)
}

export function estimateConversationTokens(messages: ClineMessage[]): number {
	return messages.reduce((total, message) => total + estimateMessageTokens(message), 0)
}

function estimateMessageTokens(message: ClineMessage): number {
	const cached = messageTokenCache.get(message)
	if (cached !== undefined) return cached
	const estimated = (() => {
		if (isInternalUsageMetadata(message)) {
			return 0
		}
		if (isEmptyJsonNoise(message.text) && !message.reasoning && !message.files?.length && !message.images?.length) {
			return 0
		}

		const text = [message.text, message.reasoning].filter(Boolean).join("\n")
		const textTokens = estimateTextTokens(limitEstimatedText(text))
		const fileTokens = Math.min(
			estimateTextTokens((message.files ?? []).join("\n")),
			MAX_ESTIMATED_FILE_TOKENS_PER_MESSAGE,
		)
		const imageTokens = (message.images?.length ?? 0) * 85
		return textTokens + fileTokens + imageTokens + 12
	})()
	messageTokenCache.set(message, estimated)
	return estimated
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

function findLastSuccessfulCompactionBoundaryIndex(messages: ClineMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].contextCompaction?.sessionId) {
			return i
		}
	}
	return -1
}
