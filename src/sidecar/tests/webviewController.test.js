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
	const envelope = { type: "grpc_request", grpc_request: { service: "StateService", method: "getLatestState" } }

	assert.deepEqual(await controller.handle({ rawJson: JSON.stringify(envelope) }), { handled: true })
	assert.deepEqual(application.received, [envelope])
})

test("webview controller rejects malformed JSON without calling the application", async () => {
	const application = createApplication()
	const controller = new VisualStudioWebviewController(application)

	assert.deepEqual(await controller.handle({ rawJson: "{" }), { handled: false, reason: "invalid_webview_json" })
	assert.equal(application.received.length, 0)
})
