const assert = require("node:assert/strict")
const test = require("node:test")
const { WebviewUnaryRpcRouter } = require("../dist/infrastructure/webview/WebviewUnaryRpcRouter")

function dependencies(overrides = {}) {
	const empty = { handle: async () => { throw new Error("unexpected route") } }
	return {
		settings: empty, account: empty, browser: empty, terminal: empty, task: empty,
		checkpoint: empty, hook: empty, scheduledAgent: empty, worktree: empty, mcp: empty,
		modelCatalog: empty, file: empty, instructionSettings: empty, uiWeb: empty, plugin: empty,
		stateMessages: () => [{ type: "state" }],
		mcpStreamMessages: (payload) => [{ type: "mcp_stream", payload }],
		...overrides,
	}
}

test("unary RPC router dispatches decoded settings commands and appends requested state", async () => {
	const received = []
	const router = new WebviewUnaryRpcRouter(dependencies({
		settings: { handle: async (command) => { received.push(command); return { payload: { ok: true }, includeStateMessages: true } } },
	}))
	const result = await router.handle("StateService.dismissBanner", "request-1", { value: "banner" })
	assert.equal(received[0].type, "dismissBanner")
	assert.deepEqual(result.webviewMessages[1], { type: "state" })
	assert.equal(result.webviewMessages[0].grpc_response.request_id, "request-1")
})

test("unary RPC router publishes MCP stream updates and contains MCP errors", async () => {
	const success = new WebviewUnaryRpcRouter(dependencies({ mcp: { handle: async () => ({ payload: { servers: [] }, publishToStreams: true }) } }))
	const successResult = await success.handle("McpService.toggleMcpServer", "mcp-1", { serverName: "one", disabled: true })
	assert.equal(successResult.webviewMessages[1].type, "mcp_stream")

	const failure = new WebviewUnaryRpcRouter(dependencies({ mcp: { handle: async () => ({ error: "offline" }) } }))
	const failureResult = await failure.handle("McpService.toggleMcpServer", "mcp-2", { serverName: "one", disabled: true })
	assert.equal(failureResult.webviewMessages[0].grpc_response.error, "offline")
})

test("unary RPC router returns null for operations outside its registry", async () => {
	const router = new WebviewUnaryRpcRouter(dependencies())
	assert.equal(await router.handle("UnknownService.missing", "unknown-1", {}), null)
})
