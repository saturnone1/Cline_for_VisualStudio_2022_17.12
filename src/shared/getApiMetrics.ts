import { ClineMessage } from "./ExtensionMessage"

interface ApiMetrics {
	totalTokensIn: number
	totalTokensOut: number
	totalCacheWrites?: number
	totalCacheReads?: number
	totalCost: number
}

export interface ContextWindowUsage {
	used: number
	source: "reported" | "estimated"
	reliable: boolean
}

const MAX_ESTIMATED_TEXT_CHARS_PER_MESSAGE = 32_000
const MAX_ESTIMATED_TOKENS_PER_MESSAGE = 8_000
const MAX_ESTIMATED_FILE_TOKENS_PER_MESSAGE = 1_000

/**
 * Calculates API metrics from an array of ClineMessages.
 *
 * This function processes usage-carrying say messages.
 * It includes:
 * - 'api_req_started' messages that have been combined with their corresponding 'api_req_finished' messages
 * - 'deleted_api_reqs' messages, which are aggregated from deleted messages
 * - 'subagent_usage' messages, which are aggregated usage snapshots emitted by subagent batches
 * It extracts and sums up the tokensIn, tokensOut, cacheWrites, cacheReads, and cost from these messages.
 *
 * @param messages - An array of ClineMessage objects to process.
 * @returns An ApiMetrics object containing totalTokensIn, totalTokensOut, totalCacheWrites, totalCacheReads, and totalCost.
 *
 * @example
 * const messages = [
 *   { type: "say", say: "api_req_started", text: '{"request":"GET /api/data","tokensIn":10,"tokensOut":20,"cost":0.005}', ts: 1000 }
 * ];
 * const { totalTokensIn, totalTokensOut, totalCost } = getApiMetrics(messages);
 * // Result: { totalTokensIn: 10, totalTokensOut: 20, totalCost: 0.005 }
 */
export function getApiMetrics(messages: ClineMessage[]): ApiMetrics {
	const result: ApiMetrics = {
		totalTokensIn: 0,
		totalTokensOut: 0,
		totalCacheWrites: undefined,
		totalCacheReads: undefined,
		totalCost: 0,
	}

	messages.forEach((message) => {
		if (
			message.type === "say" &&
			(message.say === "api_req_started" || message.say === "deleted_api_reqs" || message.say === "subagent_usage") &&
			message.text
		) {
			try {
				const parsedData = JSON.parse(message.text)
				if (parsedData.usageReliable === false) {
					return
				}
				const { tokensIn, tokensOut, cacheWrites, cacheReads, cost } = parsedData

				if (typeof tokensIn === "number") {
					result.totalTokensIn += tokensIn
				}
				if (typeof tokensOut === "number") {
					result.totalTokensOut += tokensOut
				}
				if (typeof cacheWrites === "number") {
					result.totalCacheWrites = (result.totalCacheWrites ?? 0) + cacheWrites
				}
				if (typeof cacheReads === "number") {
					result.totalCacheReads = (result.totalCacheReads ?? 0) + cacheReads
				}
				if (typeof cost === "number") {
					result.totalCost += cost
				}
			} catch {
				// Ignore JSON parse errors
			}
		}
	})

	return result
}

/**
 * Gets the total token count from the last API request.
 *
 * This is used for context window progress display - it shows how much of the
 * context window is used in the current/most recent request, not cumulative totals.
 *
 * @param messages - An array of ClineMessage objects to process.
 * @returns The total tokens (tokensIn + tokensOut + cacheWrites + cacheReads) from the last api_req_started message, or 0 if none found.
 */
export function getLastApiReqTotalTokens(messages: ClineMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]
		if (msg.type === "say" && msg.say === "api_req_started" && msg.text) {
			try {
				const { tokensIn, tokensOut, cacheWrites, cacheReads, usageReliable } = JSON.parse(msg.text)
				if (usageReliable === false) {
					continue
				}
				const total = (tokensIn || 0) + (tokensOut || 0) + (cacheWrites || 0) + (cacheReads || 0)
				if (total > 0) {
					return total
				}
			} catch {
				// Ignore JSON parse errors, continue searching
			}
		}
	}
	return 0
}

export function getContextWindowUsage(messages: ClineMessage[]): ContextWindowUsage | undefined {
	const currentContextMessages = getCurrentContextMessages(messages)
	const reported = getLastApiReqTotalTokens(currentContextMessages)
	if (reported > 0) {
		return {
			used: reported,
			source: "reported",
			reliable: true,
		}
	}

	const estimated = estimateConversationTokens(currentContextMessages)
	if (estimated <= 0) {
		return undefined
	}

	return {
		used: estimated,
		source: "estimated",
		reliable: false,
	}
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
		if (isEmptyJsonNoise(message.text) && !message.reasoning && !message.files?.length && !message.images?.length) {
			return total
		}

		const text = [message.text, message.reasoning].filter(Boolean).join("\n")
		const textTokens = Math.min(
			estimateTextTokens(limitEstimatedText(text)),
			MAX_ESTIMATED_TOKENS_PER_MESSAGE,
		)
		const fileTokens = Math.min(
			estimateTextTokens((message.files ?? []).join("\n")),
			MAX_ESTIMATED_FILE_TOKENS_PER_MESSAGE,
		)
		const imageTokens = (message.images?.length ?? 0) * 85
		const messageOverhead = 12
		return total + textTokens + fileTokens + imageTokens + messageOverhead
	}, 0)
}

function limitEstimatedText(text: string): string {
	if (text.length <= MAX_ESTIMATED_TEXT_CHARS_PER_MESSAGE) {
		return text
	}
	return text.slice(0, MAX_ESTIMATED_TEXT_CHARS_PER_MESSAGE)
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
	let otherChars = 0
	for (const char of normalized) {
		const codePoint = char.codePointAt(0) ?? 0
		if (isCjkCodePoint(codePoint)) {
			cjkChars++
		} else if (!isWhitespaceCodePoint(codePoint)) {
			otherChars++
		}
	}

	return Math.ceil(cjkChars + otherChars / 4)
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
	return messages.slice(index + 1).some((message) => {
		if (message.type !== "say") {
			return false
		}
		if (message.say === "error") {
			return false
		}
		return message.say === "text" && !!message.text?.trim()
	})
}
