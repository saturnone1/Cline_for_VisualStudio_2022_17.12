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
			{ ts: 0, type: "say", say: "task", text: "첫 질문" },
			{ ts: 1, type: "say", say: "api_req_started", text: JSON.stringify({ tokensIn: 8_000, tokensOut: 500 }) },
			{ ts: 2, type: "say", say: "api_req_started", text: JSON.stringify({ tokensIn: 1_200, tokensOut: 100, cacheReads: 300 }) },
		]

		expect(getLastApiReqTotalTokens(messages)).toBe(1_600)
		expect(getContextWindowUsage(messages)).toEqual({ used: 1_600, source: "estimated", reliable: false })
	})

	it("removes repeated SDK system and tool overhead from the displayed conversation context", () => {
		const messages: ClineMessage[] = [
			{ ts: 1, type: "say", say: "task", text: "안녕" },
			{ ts: 2, type: "say", say: "text", text: "안녕하세요!" },
			{ ts: 3, type: "say", say: "api_req_started", text: JSON.stringify({ tokensIn: 9_394, tokensOut: 47 }) },
			{ ts: 4, type: "say", say: "user_feedback", text: "브라우저 도구 사용 가능하니?" },
			{ ts: 5, type: "say", say: "text", text: "네, 사용할 수 있습니다." },
			{ ts: 6, type: "say", say: "api_req_started", text: JSON.stringify({ tokensIn: 9_425, tokensOut: 91 }) },
		]

		const usage = getContextWindowUsage(messages)
		expect(usage?.source).toBe("estimated")
		expect(usage?.used).toBeGreaterThan(100)
		expect(usage?.used).toBeLessThan(500)
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

		const usage = getContextWindowUsage(messages)
		expect(usage?.source).toBe("estimated")
		expect(usage?.used).toBeGreaterThan(estimateConversationTokens(messages.slice(1)))
		expect(usage?.used).toBeLessThan(1_000)
	})

	it("keeps the reported baseline while a subsequent response is streaming", () => {
		const messages: ClineMessage[] = [
			{ ts: 1, type: "say", say: "api_req_started", text: JSON.stringify({ tokensIn: 9_000, tokensOut: 200 }) },
			{ ts: 2, type: "say", say: "user_feedback", text: "다음 질문" },
			{ ts: 3, type: "say", say: "text", text: "응답 작성 중", partial: true },
		]

		const usage = getContextWindowUsage(messages)
		expect(usage?.source).toBe("estimated")
		expect(usage?.used).toBeLessThan(1_000)
	})

	it("does not truncate long Korean messages at the former 8k-token ceiling", () => {
		const messages: ClineMessage[] = [{ ts: 1, type: "say", say: "text", text: "가".repeat(12_000) }]
		expect(estimateConversationTokens(messages)).toBeGreaterThan(12_000)
	})

	it("resets displayed context at an explicit successful compaction boundary", () => {
		const messages: ClineMessage[] = [
			{ ts: 1, type: "say", say: "text", text: "이전 대화".repeat(2_000) },
			{ ts: 2, type: "say", say: "info", text: "컨텍스트 압축이 완료되었습니다.", contextCompaction: { sourceSessionId: "old", sessionId: "new" } },
			{ ts: 3, type: "say", say: "user_feedback", text: "다음 질문" },
		]

		const usage = getContextWindowUsage(messages)
		expect(usage?.used).toBeLessThan(100)
	})

	it("uses the validated compacted context size as the post-compaction baseline", () => {
		const messages: ClineMessage[] = [
			{ ts: 1, type: "say", say: "text", text: "이전 대화".repeat(2_000) },
			{ ts: 2, type: "say", say: "info", text: "컨텍스트 압축이 완료되었습니다.", contextCompaction: { sourceSessionId: "old", sessionId: "new", estimatedTokensAfter: 1_250 } },
			{ ts: 3, type: "say", say: "user_feedback", text: "다음 질문" },
		]

		const usage = getContextWindowUsage(messages)
		expect(usage?.used).toBeGreaterThanOrEqual(1_250)
		expect(usage?.used).toBeLessThan(1_350)
	})

	it("does not treat compaction progress text as a successful boundary", () => {
		const messages: ClineMessage[] = [
			{ ts: 1, type: "say", say: "text", text: "이전 대화".repeat(2_000) },
			{ ts: 2, type: "say", say: "reasoning", text: "컨텍스트 압축 중입니다." },
			{ ts: 3, type: "say", say: "text", text: "압축 요청을 처리할 수 없습니다." },
		]

		const usage = getContextWindowUsage(messages)
		expect(usage?.used).toBeGreaterThan(2_000)
	})
})
