const assert = require("node:assert/strict")
const test = require("node:test")
const { correlationIdFromPayload } = require("../dist/infrastructure/diagnostics/InteractionLog")

test("interaction correlation uses stable identifier priority across wire envelopes", () => {
	assert.equal(correlationIdFromPayload({ correlationId: "explicit", requestId: "request" }), "explicit")
	assert.equal(correlationIdFromPayload({ grpc_request: { request_id: "webview-1", message: { sessionId: "session-1" } } }), "webview-1")
	assert.equal(correlationIdFromPayload({ result: { grpc_response: { request_id: "response-1" } } }), "response-1")
	assert.equal(correlationIdFromPayload(JSON.stringify({ params: { sessionId: "session-2" } })), "session-2")
	assert.equal(correlationIdFromPayload({ unrelated: true }), "")
})

test("interaction correlation contains cyclic diagnostic objects", () => {
	const value = { request: null }
	value.request = value
	assert.equal(correlationIdFromPayload(value), "")
})
