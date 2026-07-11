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

test("agent runtime events preserve unknown SDK events without leaking an untyped envelope", () => {
	assert.deepEqual(
		normalizeAgentRuntimeEvent({ type: "future_event", payload: { value: 1 } }),
		{ type: "unknown", originalType: "future_event", payload: { value: 1 } },
	)
})
