const assert = require("node:assert/strict")
const test = require("node:test")
const { WebviewUnaryRpcRouter, WebviewRpcRequestCancelledError } = require("../dist/infrastructure/webview/WebviewUnaryRpcRouter")

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

test("unary RPC router aborts active work and discards its late response", async () => {
	let release
	let observedSignal
	const waiting = new Promise((resolve) => { release = resolve })
	const router = new WebviewUnaryRpcRouter(dependencies({
		task: {
			handle: async (_command, _requestId, signal) => {
				observedSignal = signal
				await waiting
				return { payload: { ok: true } }
			},
		},
	}))
	const pending = router.handle("SlashService.condense", "compact-cancelled", {})
	await Promise.resolve()
	assert.equal(router.cancel("compact-cancelled"), true)
	assert.equal(observedSignal.aborted, true)
	release()
	await assert.rejects(pending, WebviewRpcRequestCancelledError)
})

test("control-plane RPCs preserve arrival order across settings and task routes", async () => {
	const order = []
	let releaseSettings
	const settingsGate = new Promise((resolve) => { releaseSettings = resolve })
	const router = new WebviewUnaryRpcRouter(dependencies({
		settings: { handle: async () => { order.push("settings:start"); await settingsGate; order.push("settings:end"); return { payload: {} } } },
		task: { handle: async () => { order.push("task"); return { payload: {} } } },
	}))

	const settings = router.handle("StateService.dismissBanner", "settings-ordered", { value: "banner" })
	const task = router.handle("TaskService.newTask", "task-ordered", { text: "hello" })
	await Promise.resolve()
	assert.deepEqual(order, ["settings:start"])
	releaseSettings()
	await Promise.all([settings, task])
	assert.deepEqual(order, ["settings:start", "settings:end", "task"])
})

test("a queued control-plane RPC can be cancelled without running later", async () => {
	let releaseSettings
	let taskCalls = 0
	const settingsGate = new Promise((resolve) => { releaseSettings = resolve })
	const router = new WebviewUnaryRpcRouter(dependencies({
		settings: { handle: async () => { await settingsGate; return { payload: {} } } },
		task: { handle: async () => { taskCalls++; return { payload: {} } } },
	}))

	const settings = router.handle("StateService.dismissBanner", "settings-blocking", { value: "banner" })
	const task = router.handle("TaskService.newTask", "task-cancelled", { text: "hello" })
	assert.equal(router.cancel("task-cancelled"), true)
	await assert.rejects(task, WebviewRpcRequestCancelledError)
	releaseSettings()
	await settings
	await new Promise((resolve) => setImmediate(resolve))
	assert.equal(taskCalls, 0)
})

test("an active control-plane RPC observes cancellation and remains serialized until it settles", async () => {
	let releaseSettings
	let observedSignal
	let taskCalls = 0
	const settingsGate = new Promise((resolve) => { releaseSettings = resolve })
	const router = new WebviewUnaryRpcRouter(dependencies({
		settings: { handle: async (_command, signal) => { observedSignal = signal; await settingsGate; return { payload: {} } } },
		task: { handle: async () => { taskCalls++; return { payload: {} } } },
	}))

	const settings = router.handle("StateService.dismissBanner", "settings-active", { value: "banner" })
	await Promise.resolve()
	assert.equal(router.cancel("settings-active"), true)
	assert.equal(observedSignal.aborted, true)

	const task = router.handle("TaskService.newTask", "task-after-cancel", { text: "hello" })
	await Promise.resolve()
	assert.equal(taskCalls, 0)

	releaseSettings()
	await assert.rejects(settings, WebviewRpcRequestCancelledError)
	await task
	assert.equal(taskCalls, 1)
})
