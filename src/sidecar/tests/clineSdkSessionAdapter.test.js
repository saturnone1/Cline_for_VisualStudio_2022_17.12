const assert = require("node:assert/strict")
const test = require("node:test")
const { ClineSdkSessionAdapter } = require("../dist/infrastructure/sdk/ClineSdkSessionAdapter")

function createAdapter(coreOverrides = {}, adapterOverrides = {}) {
	let activeSessionId = null
	let getCoreCalls = 0
	const calls = []
	const core = {
		start: async (request) => { calls.push(["start", request]); return { sessionId: "started-session", manifest: { status: "idle" } } },
		get: async (sessionId) => { calls.push(["get", sessionId]); return { sessionId, status: "idle" } },
		send: async (request) => { calls.push(["send", request]); return { accepted: true } },
		stop: async (sessionId) => { calls.push(["stop", sessionId]) },
		abort: async (sessionId) => { calls.push(["abort", sessionId]) },
		update: async (sessionId, updates) => { calls.push(["update", sessionId, updates]); return { updated: true } },
		updateSessionConnection: async (sessionId, updates) => { calls.push(["updateSessionConnection", sessionId, updates]) },
		subscribe: () => () => undefined,
		delete: async (sessionId) => { calls.push(["delete", sessionId]); return true },
		...coreOverrides,
	}
	const adapter = new ClineSdkSessionAdapter({
		getCore: async () => { getCoreCalls += 1; return core },
		getCurrentCore: () => core,
		getActiveSessionId: () => activeSessionId,
		setActiveSessionId: (value) => { activeSessionId = value },
		getWorkspacePaths: async () => ["C:\\workspace"],
		createExtraTools: async () => [{ name: "mcp_tool" }],
		getStatus: () => ({ activeSessionId }),
		...adapterOverrides,
	})
	return {
		adapter,
		calls,
		getActiveSessionId: () => activeSessionId,
		setActiveSessionId: (value) => { activeSessionId = value },
		getCoreCalls: () => getCoreCalls,
	}
}

test("SDK session adapter owns start and send session transitions", async () => {
	const fixture = createAdapter()
	const started = await fixture.adapter.start({
		prompt: "inspect",
		cwd: "",
		sessionId: "requested-session",
		mode: "plan",
	})
	assert.equal(started.sessionId, "started-session")
	assert.equal(fixture.getActiveSessionId(), "started-session")
	assert.equal(fixture.calls[0][1].config.sessionId, "requested-session")
	assert.deepEqual(fixture.calls[0][1].config.extraTools, [{ name: "mcp_tool" }])

	await fixture.adapter.send({ sessionId: "", prompt: "continue", mode: "act", delivery: "queue", userFiles: ["a.ts"] })
	assert.deepEqual(fixture.calls[1], ["send", {
		sessionId: "started-session",
		prompt: "continue",
		mode: "act",
		delivery: "queue",
		userImages: [],
		userFiles: ["a.ts"],
	}])
})

test("SDK session adapter clears stale sessions after start and send failures", async () => {
	const startFixture = createAdapter({ start: async () => { throw new Error("start failed") } })
	await assert.rejects(() => startFixture.adapter.start({ prompt: "inspect", cwd: "", sessionId: "requested" }), /start failed/)
	assert.equal(startFixture.getActiveSessionId(), null)

	const sendFixture = createAdapter({ send: async () => { throw new Error("Session not found") } })
	sendFixture.setActiveSessionId("stale")
	await assert.rejects(() => sendFixture.adapter.send({ sessionId: "", prompt: "again" }), /Session not found/)
	assert.equal(sendFixture.getActiveSessionId(), null)
})

test("SDK session adapter clears the active selection when activation cannot find the session", async () => {
	const fixture = createAdapter({ get: async () => null })
	fixture.setActiveSessionId("previous")

	assert.equal(await fixture.adapter.activate("missing"), null)
	assert.equal(fixture.getActiveSessionId(), null)
})

test("SDK session adapter preserves active selection when deletion fails", async () => {
	const fixture = createAdapter({ delete: async () => false })
	fixture.setActiveSessionId("active")

	assert.equal(await fixture.adapter.deleteSession({ sessionId: "active" }), false)
	assert.equal(fixture.getActiveSessionId(), "active")
})

test("SDK session adapter only updates fields explicitly supplied by the caller", async () => {
	const fixture = createAdapter()
	fixture.setActiveSessionId("active")

	await fixture.adapter.updateSession({ sessionId: "active", title: "Renamed" })
	assert.deepEqual(fixture.calls[0], ["update", "active", { title: "Renamed" }])

	await fixture.adapter.updateSession({ sessionId: "active", prompt: null, metadata: { source: "history" } })
	assert.deepEqual(fixture.calls[1], ["update", "active", { prompt: null, metadata: { source: "history" } }])
})

test("SDK session adapter updates a live session connection", async () => {
	const fixture = createAdapter()
	fixture.setActiveSessionId("active")
	await fixture.adapter.updateConnection({ sessionId: "active", providerId: "openai-compatible", modelId: "model", providerConfig: { modelInfo: { contextWindow: 4096 } }, thinking: null })
	assert.deepEqual(fixture.calls[0], ["updateSessionConnection", "active", { providerId: "openai-compatible", modelId: "model", providerConfig: { modelInfo: { contextWindow: 4096 } }, thinking: null }])
})

test("SDK session adapter stop does not start an absent core", async () => {
	let activeSessionId = "active"
	let getCoreCalls = 0
	const adapter = new ClineSdkSessionAdapter({
		getCore: async () => { getCoreCalls += 1; throw new Error("must not start") },
		getCurrentCore: () => null,
		getActiveSessionId: () => activeSessionId,
		setActiveSessionId: (value) => { activeSessionId = value },
		getWorkspacePaths: async () => [],
		createExtraTools: async () => undefined,
		getStatus: () => ({ activeSessionId }),
	})

	assert.deepEqual(await adapter.stop({ sessionId: "active" }), { activeSessionId: "active" })
	assert.equal(getCoreCalls, 0)
})

test("SDK session adapter abort does not recreate a disposed core", async () => {
	let activeSessionId = "active"
	let getCoreCalls = 0
	const adapter = new ClineSdkSessionAdapter({
		getCore: async () => { getCoreCalls += 1; throw new Error("must not start") },
		getCurrentCore: () => null,
		getActiveSessionId: () => activeSessionId,
		setActiveSessionId: (value) => { activeSessionId = value },
		getWorkspacePaths: async () => [],
		createExtraTools: async () => undefined,
		getStatus: () => ({ activeSessionId }),
	})

	assert.deepEqual(await adapter.abort({ sessionId: "active" }), { activeSessionId: "active" })
	assert.equal(getCoreCalls, 0)
})
