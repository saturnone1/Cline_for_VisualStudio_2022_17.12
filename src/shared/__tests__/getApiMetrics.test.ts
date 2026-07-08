import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import type { ClineMessage } from "../ExtensionMessage"
import { estimateConversationTokens, getApiMetrics, getContextWindowUsage, getCurrentContextMessages, getLastApiReqTotalTokens } from "../getApiMetrics"

describe("getApiMetrics", () => {
	it("includes subagent_usage in aggregate totals", () => {
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({
					tokensIn: 10,
					tokensOut: 20,
					cacheWrites: 3,
					cacheReads: 1,
					cost: 0.12,
				}),
			},
			{
				ts: 2,
				type: "say",
				say: "subagent_usage",
				text: JSON.stringify({
					source: "subagents",
					tokensIn: 4,
					tokensOut: 8,
					cacheWrites: 2,
					cacheReads: 1,
					cost: 0.05,
				}),
			},
			{
				ts: 3,
				type: "say",
				say: "deleted_api_reqs",
				text: JSON.stringify({
					tokensIn: 6,
					tokensOut: 9,
					cacheWrites: 1,
					cacheReads: 0,
					cost: 0.03,
				}),
			},
		]

		const metrics = getApiMetrics(messages)

		assert.equal(metrics.totalTokensIn, 20)
		assert.equal(metrics.totalTokensOut, 37)
		assert.equal(metrics.totalCacheWrites, 6)
		assert.equal(metrics.totalCacheReads, 2)
		assert.ok(Math.abs(metrics.totalCost - 0.2) < 1e-9)
	})

	it("ignores malformed usage payloads", () => {
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "subagent_usage",
				text: "{not-json",
			},
		]

		const metrics = getApiMetrics(messages)
		assert.equal(metrics.totalTokensIn, 0)
		assert.equal(metrics.totalTokensOut, 0)
		assert.equal(metrics.totalCost, 0)
	})

	it("ignores explicit unreliable placeholder usage payloads", () => {
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({
					tokensIn: 999,
					tokensOut: 999,
					cost: 1,
					usageReliable: false,
				}),
			},
		]

		const metrics = getApiMetrics(messages)
		assert.equal(metrics.totalTokensIn, 0)
		assert.equal(metrics.totalTokensOut, 0)
		assert.equal(metrics.totalCost, 0)
	})
})

describe("getLastApiReqTotalTokens", () => {
	it("uses only the latest api_req_started payload", () => {
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "subagent_usage",
				text: JSON.stringify({
					source: "subagents",
					tokensIn: 100,
					tokensOut: 200,
				}),
			},
			{
				ts: 2,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({
					tokensIn: 11,
					tokensOut: 7,
					cacheWrites: 2,
					cacheReads: 3,
				}),
			},
		]

		const total = getLastApiReqTotalTokens(messages)
		assert.equal(total, 23)
	})

	it("skips unreliable placeholder payloads when finding the latest usage", () => {
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({
					tokensIn: 11,
					tokensOut: 7,
				}),
			},
			{
				ts: 2,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({
					tokensIn: 0,
					tokensOut: 0,
					usageReliable: false,
				}),
			},
		]

		const total = getLastApiReqTotalTokens(messages)
		assert.equal(total, 18)
	})
})

describe("getContextWindowUsage", () => {
	it("estimates only the current context after the latest compaction boundary", () => {
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "text",
				text: "압축 전 아주 긴 대화 ".repeat(200),
			},
			{
				ts: 2,
				type: "say",
				say: "reasoning",
				text: "컨텍스트 압축 중입니다.",
			},
			{
				ts: 3,
				type: "say",
				say: "text",
				text: "압축 요약",
			},
		]

		const currentContextMessages = getCurrentContextMessages(messages)
		const usage = getContextWindowUsage(messages)

		assert.equal(currentContextMessages.length, 1)
		assert.equal(currentContextMessages[0].ts, 3)
		assert.equal(usage?.source, "estimated")
		assert.equal(usage?.used, estimateConversationTokens(currentContextMessages))
		assert.ok((usage?.used ?? 0) < estimateConversationTokens(messages))
	})

	it("uses reported usage only after the latest compaction boundary", () => {
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({
					tokensIn: 10_000,
					tokensOut: 500,
				}),
			},
			{
				ts: 2,
				type: "say",
				say: "reasoning",
				text: "Compacting context...",
			},
			{
				ts: 3,
				type: "say",
				say: "text",
				text: "Compact summary",
			},
		]

		const usage = getContextWindowUsage(messages)

		assert.equal(usage?.source, "estimated")
		assert.ok((usage?.used ?? 0) < 10_500)
	})

	it("does not treat failed compaction as a context boundary", () => {
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "text",
				text: "압축 전 아주 긴 대화 ".repeat(200),
			},
			{
				ts: 2,
				type: "say",
				say: "reasoning",
				text: "컨텍스트 압축 중입니다.",
			},
			{
				ts: 3,
				type: "say",
				say: "error",
				text: "compact failed",
			},
		]

		const currentContextMessages = getCurrentContextMessages(messages)
		const usage = getContextWindowUsage(messages)

		assert.equal(currentContextMessages.length, messages.length)
		assert.equal(usage?.used, estimateConversationTokens(messages))
	})
})
