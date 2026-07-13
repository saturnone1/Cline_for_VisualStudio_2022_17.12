import type { ClineMessage } from "@shared/ExtensionMessage"
import {
	estimateConversationTokens,
	getContextWindowUsage,
	getLastApiReqTotalTokens,
} from "@shared/contextWindowUsage"
import { describe, expect, it } from "vitest"

describe("context window usage", () => {
	it("uses the latest model call instead of accumulated session totals", () => {
		const messages: ClineMessage[] = [
			{ ts: 1, type: "say", say: "api_req_started", text: JSON.stringify({ tokensIn: 8_000, tokensOut: 500 }) },
			{ ts: 2, type: "say", say: "api_req_started", text: JSON.stringify({ tokensIn: 1_200, tokensOut: 100, cacheReads: 300 }) },
		]

		expect(getLastApiReqTotalTokens(messages)).toBe(1_600)
		expect(getContextWindowUsage(messages)).toEqual({ used: 1_600, source: "reported", reliable: true })
	})

	it("estimates the current transcript when the latest usage is unreliable", () => {
		const messages: ClineMessage[] = [
			{ ts: 1, type: "say", say: "text", text: "이전 대화".repeat(100) },
			{ ts: 2, type: "say", say: "api_req_started", text: JSON.stringify({ usageReliable: false }) },
		]

		const usage = getContextWindowUsage(messages)
		expect(usage?.source).toBe("estimated")
		expect(usage?.used).toBe(estimateConversationTokens(messages))
	})

	it("does not reuse a reported snapshot after new user context arrives", () => {
		const messages: ClineMessage[] = [
			{ ts: 1, type: "say", say: "api_req_started", text: JSON.stringify({ tokensIn: 1_000, tokensOut: 50 }) },
			{ ts: 2, type: "say", say: "user_feedback", text: "새 질문".repeat(100) },
		]

		expect(getContextWindowUsage(messages)?.source).toBe("estimated")
	})

	it("does not truncate long Korean messages at the former 8k-token ceiling", () => {
		const messages: ClineMessage[] = [{ ts: 1, type: "say", say: "text", text: "가".repeat(12_000) }]
		expect(estimateConversationTokens(messages)).toBeGreaterThan(12_000)
	})
})
