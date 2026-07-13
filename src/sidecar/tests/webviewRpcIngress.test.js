const assert = require("node:assert/strict")
const test = require("node:test")
const { WebviewRpcIngress } = require("../dist/infrastructure/webview/WebviewRpcIngress")

function createIngress(overrides = {}) {
	const logs = []
	const errors = []
	const unary = overrides.unary || { handle: async (key, requestId, message) => ({ handled: true, key, requestId, message, webviewMessages: [] }) }
	const streaming = overrides.streaming || {
		handle: async () => ({ handled: true, webviewMessages: [] }),
		unsubscribe: () => true,
	}
	return {
		ingress: new WebviewRpcIngress({
			logger: { log: (...args) => logs.push(args) },
			unary,
			streaming,
			onUnaryError: async (error) => { errors.push(error) },
			slowRequestThresholdMs: () => Number.MAX_SAFE_INTEGER,
		}),
		logs,
		errors,
	}
}

test("WebView RPC ingress validates and dispatches unary requests", async () => {
	const fixture = createIngress()
	const result = await fixture.ingress.handle({
		type: "grpc_request",
		request: { service: "UiService", method: "openUrl", requestId: "url-1", isStreaming: false, message: { value: "https://example.com" } },
	})

	assert.equal(result.handled, true)
	assert.equal(result.key, "UiService.openUrl")
	assert.equal(result.requestId, "url-1")
})

test("WebView RPC ingress contains unary errors and invokes state projection", async () => {
	const fixture = createIngress({ unary: { handle: async () => { throw new Error("broken request") } } })
	const result = await fixture.ingress.handle({
		type: "grpc_request",
		request: { service: "UiService", method: "openUrl", requestId: "url-2", isStreaming: false, message: { value: "https://example.com" } },
	})

	assert.equal(fixture.errors.length, 1)
	assert.equal(result.webviewMessages[0].grpc_response.error, "broken request")
})

test("WebView RPC ingress owns stream cancellation and unhandled envelopes", async () => {
	const fixture = createIngress()
	assert.deepEqual(await fixture.ingress.handle({ type: "grpc_request_cancel", requestId: "stream-1" }), {
		handled: true,
		owner: "sidecar",
		webviewMessages: [],
	})
	assert.deepEqual(await fixture.ingress.handle({ type: "unhandled", originalType: "theme_changed", message: {} }), {
		handled: false,
		type: "theme_changed",
		webviewMessages: [],
	})
})
