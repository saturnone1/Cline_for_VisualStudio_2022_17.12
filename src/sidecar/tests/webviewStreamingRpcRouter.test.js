const assert = require("node:assert/strict")
const test = require("node:test")
const { StreamingRpcHandler } = require("../dist/features/web/StreamingRpcHandler")
const { WebviewStreamingRpcRouter } = require("../dist/infrastructure/webview/WebviewStreamingRpcRouter")

function createRouter() {
	const events = []
	const handler = new StreamingRpcHandler({
		scheduleStateRefresh: () => events.push("refresh"),
		subscribeState: (requestId) => ({ type: "state", requestId }),
		subscribePartial: (requestId) => events.push(`partial:${requestId}`),
		unauthenticatedAccount: () => ({ user: null }),
		mcpServers: async () => ({ servers: [] }),
		mcpMarketplace: async () => ({ items: [] }),
	})
	const transportRequests = new Set(["transport-1"])
	return {
		events,
		router: new WebviewStreamingRpcRouter({ handler, unsubscribeTransport: (requestId) => transportRequests.delete(requestId) }),
	}
}

test("streaming RPC router translates state and auth subscriptions into wire responses", async () => {
	const { router, events } = createRouter()
	const state = await router.handle("StateService.subscribeToState", "state-1")
	assert.deepEqual(events, ["refresh"])
	assert.deepEqual(state.webviewMessages[0], { type: "state", requestId: "state-1" })

	const auth = await router.handle("AccountService.subscribeToAuthStatusUpdate", "auth-1")
	assert.deepEqual(auth.webviewMessages[0].grpc_response.message, { user: null })
	assert.equal(auth.webviewMessages[0].grpc_response.is_streaming, true)
})

test("streaming RPC router owns MCP fan-out, cancellation, and unknown routes", async () => {
	const { router } = createRouter()
	await router.handle("McpService.subscribeToMcpServers", "mcp-1")
	assert.equal(router.mcpMessages({ servers: ["one"] })[0].grpc_response.request_id, "mcp-1")
	assert.equal(router.unsubscribe("mcp-1"), true)
	assert.deepEqual(router.mcpMessages({ servers: [] }), [])
	assert.equal(router.unsubscribe("transport-1"), true)
	assert.equal(await router.handle("MissingService.subscribe", "missing-1"), null)
})
