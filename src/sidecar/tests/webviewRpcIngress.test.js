const assert = require("node:assert/strict")
const test = require("node:test")
const { WebviewRpcIngress } = require("../dist/infrastructure/webview/WebviewRpcIngress")
const { WebviewRpcRequestCancelledError } = require("../dist/infrastructure/webview/WebviewUnaryRpcRouter")

function createIngress(overrides = {}) {
	const logs = []
	const errors = []
	const unary = overrides.unary || { handle: async (key, requestId, message) => ({ handled: true, key, requestId, message, webviewMessages: [] }), cancel: () => false }
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
	const fixture = createIngress({ unary: { handle: async () => { throw new Error("broken request") }, cancel: () => false } })
	const result = await fixture.ingress.handle({
		type: "grpc_request",
		request: { service: "UiService", method: "openUrl", requestId: "url-2", isStreaming: false, message: { value: "https://example.com" } },
	})

	assert.equal(fixture.errors.length, 1)
	assert.equal(result.webviewMessages[0].grpc_response.error, "broken request")
})

test("WebView RPC ingress propagates unary cancellation", async () => {
	let cancelled = ""
	const fixture = createIngress({
		unary: { handle: async () => ({ handled: true, webviewMessages: [] }), cancel: (requestId) => { cancelled = requestId; return true } },
		streaming: { handle: async () => ({ handled: true, webviewMessages: [] }), unsubscribe: () => false },
	})
	await fixture.ingress.handle({ type: "grpc_request_cancel", requestId: "compact-1" })
	assert.equal(cancelled, "compact-1")
})

test("WebView RPC ingress silently discards a cancelled unary response", async () => {
	const fixture = createIngress({
		unary: { handle: async () => { throw new WebviewRpcRequestCancelledError("compact-2") }, cancel: () => false },
	})
	const result = await fixture.ingress.handle({
		type: "grpc_request",
		request: { service: "SlashService", method: "condense", requestId: "compact-2", isStreaming: false, message: {} },
	})
	assert.equal(fixture.errors.length, 0)
	assert.deepEqual(result.webviewMessages, [])
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
