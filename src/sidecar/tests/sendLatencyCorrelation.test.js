const assert = require("node:assert/strict")
const test = require("node:test")
const { SendLatencyMonitor } = require("../dist/features/runtime/SendLatencyMonitor")
const { WebviewRuntimeEventIngress } = require("../dist/infrastructure/webview/WebviewRuntimeEventIngress")
const { WebviewStreamPublisher } = require("../dist/infrastructure/webview/WebviewStreamPublisher")

test("request correlation survives SDK send, event, assistant, and session rebinding", () => {
	const entries = []
	const monitor = new SendLatencyMonitor({ log: (direction, event, payload) => entries.push({ direction, event, payload }) })
	monitor.start("webview-request-1", "newTask", "local-task", 12)
	monitor.markSdkSend("local-task")
	monitor.markFirstSdkEvent("local-task", "TextDelta")
	monitor.rebind("local-task", "sdk-session")
	monitor.markFirstAssistant("sdk-session", 5)

	assert.equal(monitor.correlationId("sdk-session"), "webview-request-1")
	assert.equal(entries.length, 4)
	for (const entry of entries) {
		assert.equal(entry.payload.correlationId, "webview-request-1")
		assert.equal(entry.payload.requestId, "webview-request-1")
	}
})

test("SDK ingress logs the originating WebView correlation", () => {
	const entries = []
	let dispatched = false
	const ingress = new WebviewRuntimeEventIngress(
		{ log: (direction, event, payload) => entries.push({ direction, event, payload }) },
		{ handle: () => { dispatched = true } },
		(sessionId) => sessionId === "sdk-session" ? "webview-request-2" : "",
	)
	ingress.handle({ type: "status", sessionId: "sdk-session", status: "running", lifecycle: {}, payload: { sessionId: "sdk-session" } })

	assert.equal(dispatched, true)
	assert.equal(entries[0].payload.correlationId, "webview-request-2")
	assert.equal(entries[0].payload.requestId, "webview-request-2")
})

test("state and partial WebView stream envelopes carry the originating request correlation", async () => {
	const sent = []
	const publisher = new WebviewStreamPublisher(
		{ send: async (_method, params) => { sent.push(params.message) } },
		{ log: () => {} },
		() => JSON.stringify({ task: "active" }),
		() => "webview-request-3",
	)

	const initial = publisher.subscribeState("state-subscription")
	assert.equal(initial.grpc_response.correlation_id, "webview-request-3")
	publisher.subscribePartial("partial-subscription")
	publisher.sendPartial({ ts: 1, type: "say", say: "text", text: "hello", partial: true })
	await Promise.resolve()

	assert.equal(sent[0].grpc_response.request_id, "partial-subscription")
	assert.equal(sent[0].grpc_response.correlation_id, "webview-request-3")
})
