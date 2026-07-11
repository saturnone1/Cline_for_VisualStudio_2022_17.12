const assert = require("node:assert/strict")
const test = require("node:test")
const { VisualStudioWebviewController } = require("../dist/presentation/webview/VisualStudioWebviewController")

function createApplication() {
	const received = []
	return {
		received,
		dispose() {},
		isScheduledAgentsEnabled() { return false },
		requestToolApproval: async () => ({ approved: false }),
		requestQuestion: async () => "",
		handleSdkEvent() {},
		handle: async (envelope) => { received.push(envelope); return { handled: true } },
	}
}

test("webview controller parses raw JSON before invoking the application", async () => {
	const application = createApplication()
	const controller = new VisualStudioWebviewController(application)
	const envelope = { type: "grpc_request", grpc_request: { service: "StateService", method: "getLatestState", request_id: "request-1" } }

	assert.deepEqual(await controller.handle({ rawJson: JSON.stringify(envelope) }), { handled: true })
	assert.deepEqual(application.received, [{
		type: "grpc_request",
		request: {
			service: "StateService",
			method: "getLatestState",
			requestId: "request-1",
			isStreaming: false,
			message: {},
		},
	}])
})

test("webview controller rejects incomplete gRPC contracts at the boundary", async () => {
	const application = createApplication()
	const controller = new VisualStudioWebviewController(application)

	assert.deepEqual(
		await controller.handle({ rawJson: JSON.stringify({ type: "grpc_request", grpc_request: { service: "StateService" } }) }),
		{ handled: false, reason: "missing_grpc_method" },
	)
	assert.equal(application.received.length, 0)
})

test("webview controller rejects malformed JSON without calling the application", async () => {
	const application = createApplication()
	const controller = new VisualStudioWebviewController(application)

	assert.deepEqual(await controller.handle({ rawJson: "{" }), { handled: false, reason: "invalid_webview_json" })
	assert.equal(application.received.length, 0)
})
