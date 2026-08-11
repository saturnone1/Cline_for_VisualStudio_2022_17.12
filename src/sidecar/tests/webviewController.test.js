const assert = require("node:assert/strict")
const test = require("node:test")
const { VisualStudioWebviewController } = require("../dist/presentation/webview/VisualStudioWebviewController")
const protocolVersion = 1

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

	assert.deepEqual(await controller.handle({ protocolVersion, rawJson: JSON.stringify(envelope) }), {
		protocolVersion,
		handled: true,
		webviewMessages: [],
	})
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
		await controller.handle({ protocolVersion, rawJson: JSON.stringify({ type: "grpc_request", grpc_request: { service: "StateService" } }) }),
		{ protocolVersion, handled: false, reason: "missing_grpc_method", webviewMessages: [] },
	)
	assert.equal(application.received.length, 0)
})

test("webview controller rejects malformed JSON without calling the application", async () => {
	const application = createApplication()
	const controller = new VisualStudioWebviewController(application)

	assert.deepEqual(await controller.handle({ protocolVersion, rawJson: "{" }), {
		protocolVersion,
		handled: false,
		reason: "invalid_webview_json",
		webviewMessages: [],
	})
	assert.equal(application.received.length, 0)
})

test("webview controller rejects an unversioned or incompatible host contract", async () => {
	const application = createApplication()
	const controller = new VisualStudioWebviewController(application)

	assert.deepEqual(await controller.handle({ rawJson: "{}" }), {
		protocolVersion,
		handled: false,
		reason: "unsupported_protocol_version",
		webviewMessages: [],
	})
	assert.deepEqual(await controller.handle({ protocolVersion: 2, rawJson: "{}" }), {
		protocolVersion,
		handled: false,
		reason: "unsupported_protocol_version",
		webviewMessages: [],
	})
	assert.equal(application.received.length, 0)
})
