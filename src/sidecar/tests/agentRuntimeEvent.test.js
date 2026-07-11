const assert = require("node:assert/strict")
const test = require("node:test")
const { normalizeAgentRuntimeEvent } = require("../dist/domain/agent/AgentRuntimeEvent")

test("agent runtime events normalize SDK status fields at the adapter boundary", () => {
	assert.deepEqual(
		normalizeAgentRuntimeEvent({ type: "status", payload: { sessionId: "session-1", status: "running" } }),
		{ type: "status", sessionId: "session-1", status: "running", payload: { sessionId: "session-1", status: "running" } },
	)
})

test("agent runtime events preserve unknown SDK events without leaking an untyped envelope", () => {
	assert.deepEqual(
		normalizeAgentRuntimeEvent({ type: "future_event", payload: { value: 1 } }),
		{ type: "unknown", originalType: "future_event", payload: { value: 1 } },
	)
})
