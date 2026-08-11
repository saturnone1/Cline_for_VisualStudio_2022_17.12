const assert = require("node:assert/strict")
const test = require("node:test")
const { normalizeAgentRuntimeEvent, translateClineAgentEvent, translateToolApprovalRequest } = require("../dist/infrastructure/sdk/ClineSdkEventTranslator")

test("agent runtime events normalize SDK status fields at the adapter boundary", () => {
	assert.deepEqual(
		normalizeAgentRuntimeEvent({ type: "status", payload: { sessionId: "session-1", status: "running" } }),
		{
			type: "status",
			sessionId: "session-1",
			status: "running",
			lifecycle: { type: "AgentStarted", sessionId: "session-1", raw: { sessionId: "session-1", status: "running" } },
			payload: { sessionId: "session-1", status: "running" },
		},
	)
})

test("SDK approval callbacks translate to ApprovalRequested events", () => {
	assert.deepEqual(
		translateToolApprovalRequest({ toolName: "editor", input: { path: "README.md" } }, "session-3"),
		{
			type: "ApprovalRequested",
			sessionId: "session-3",
			toolName: "editor",
			input: { path: "README.md" },
			raw: { toolName: "editor", input: { path: "README.md" } },
		},
	)
})

test("Cline content events translate to product text and tool events", () => {
	assert.deepEqual(
		translateClineAgentEvent({ type: "content_delta", contentType: "text", delta: "hello" }, "session-2"),
		{
			type: "TextDelta",
			sessionId: "session-2",
			text: "hello",
			accumulated: "",
			phase: "update",
			raw: { type: "content_delta", contentType: "text", delta: "hello" },
		},
	)
	assert.equal(
		translateClineAgentEvent({ type: "content_start", contentType: "tool", toolName: "editor", input: {} }, "session-2").type,
		"ToolCallRequested",
	)
})

test("Cline usage events preserve per-call tokens separately from accumulated totals", () => {
	assert.deepEqual(
		translateClineAgentEvent({
			type: "usage",
			inputTokens: 120,
			outputTokens: 30,
			cacheReadTokens: 40,
			cacheWriteTokens: 10,
			cost: 0.01,
			totalInputTokens: 900,
			totalOutputTokens: 200,
			totalCacheReadTokens: 300,
			totalCacheWriteTokens: 50,
			totalCost: 0.09,
		}, "session-usage"),
		{
			type: "UsageUpdated",
			sessionId: "session-usage",
			usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 40, cacheWriteTokens: 10, cost: 0.01 },
			totalInputTokens: 900,
			totalOutputTokens: 200,
			totalCacheReadTokens: 300,
			totalCacheWriteTokens: 50,
			totalCost: 0.09,
			raw: {
				type: "usage",
				inputTokens: 120,
				outputTokens: 30,
				cacheReadTokens: 40,
				cacheWriteTokens: 10,
				cost: 0.01,
				totalInputTokens: 900,
				totalOutputTokens: 200,
				totalCacheReadTokens: 300,
				totalCacheWriteTokens: 50,
				totalCost: 0.09,
			},
		},
	)
})

test("SDK compaction progress notices remain transient status instead of chat text", () => {
	assert.deepEqual(
		translateClineAgentEvent({
			type: "notice",
			message: "auto-compacting",
			reason: "auto_compaction",
			iteration: 3,
		}, "session-compaction"),
		{
			type: "NoticeReceived",
			sessionId: "session-compaction",
			message: "auto-compacting",
			reason: "auto_compaction",
			noticeType: "status",
			raw: { type: "notice", message: "auto-compacting", reason: "auto_compaction", iteration: 3 },
		},
	)
})

test("unrecognized SDK notices remain machine status instead of assistant dialogue", () => {
	const translated = translateClineAgentEvent({
		type: "notice",
		message: "compaction-budget-adjusted",
		reason: "compaction_budget_emergency",
	}, "session-notice")

	assert.equal(translated.type, "NoticeReceived")
	assert.equal(translated.noticeType, "status")
})

test("SDK agent errors preserve recoverability and iteration metadata", () => {
	const error = new Error("temporary provider failure")
	assert.deepEqual(
		translateClineAgentEvent({ type: "error", error, recoverable: true, iteration: 4 }, "session-retry"),
		{
			type: "AgentError",
			sessionId: "session-retry",
			error,
			recoverable: true,
			iteration: 4,
			raw: { type: "error", error, recoverable: true, iteration: 4 },
		},
	)
})

test("SDK done events preserve their terminal reason", () => {
	const event = translateClineAgentEvent({ type: "done", reason: "mistake_limit", text: "Unable to continue" }, "session-done")
	assert.equal(event.type, "AgentDone")
	assert.equal(event.reason, "mistake_limit")
})

test("agent runtime events preserve unknown SDK events without leaking an untyped envelope", () => {
	assert.deepEqual(
		normalizeAgentRuntimeEvent({ type: "future_event", payload: { value: 1 } }),
		{ type: "unknown", originalType: "future_event", payload: { value: 1 } },
	)
})
