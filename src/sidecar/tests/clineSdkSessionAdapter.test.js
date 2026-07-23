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
		summarizeCompaction: async () => "A durable model-generated summary that preserves the original goal, completed work, important files, runtime state, constraints, unresolved issues, and concrete next steps for the replacement agent session.",
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

test("SDK session adapter creates and validates a fresh session without deleting the source", async () => {
	const fixture = createAdapter()
	const result = await fixture.adapter.compact({ sourceSessionId: "source", cwd: "C:\\workspace", initialMessages: [{ role: "user", content: "summary" }], config: { sessionId: "source", providerId: "test" }, toolPolicies: {} })
	assert.equal(result.sessionId, "started-session")
	assert.equal(result.sourceSessionDeleted, false)
	assert.equal(fixture.getActiveSessionId(), "started-session")
	assert.equal(fixture.calls[0][1].config.sessionId, undefined)
	assert.equal("prompt" in fixture.calls[0][1], false)
	assert.equal(fixture.calls[0][1].initialMessages, undefined)
	assert.match(fixture.calls[0][1].config.systemPrompt, /<lig-vs-compacted-context>/)
	assert.match(fixture.calls[0][1].config.systemPrompt, /model-generated summary/)
	assert.match(fixture.calls[0][1].sessionMetadata.ligVsCompactedContext, /model-generated summary/)
	assert.match(result.compactionSummary, /model-generated summary/)
	assert.ok(result.estimatedTokensAfter > 0)
	assert.deepEqual(fixture.calls.slice(1), [])
})

test("SDK session adapter accepts a created replacement independently of its runtime status", async () => {
	const fixture = createAdapter({
		start: async (request) => {
			fixture.calls.push(["start", request])
			return { sessionId: "busy-replacement", manifest: { status: "running" } }
		},
	})

	const result = await fixture.adapter.compact({ sourceSessionId: "source", cwd: "C:\\workspace", initialMessages: [{ role: "user", content: "summary" }], config: { providerId: "test" }, toolPolicies: {} })
	assert.equal(result.sessionId, "busy-replacement")
	assert.equal(fixture.getActiveSessionId(), "busy-replacement")
	assert.deepEqual(fixture.calls.slice(1), [])
})

test("SDK session adapter rejects an invalid replacement before touching the source", async () => {
	const fixture = createAdapter({ start: async (request) => { fixture.calls.push(["start", request]); return { sessionId: "" } } })
	await assert.rejects(
		() => fixture.adapter.compact({ sourceSessionId: "source", cwd: "C:\\workspace", initialMessages: [{ role: "user", content: "summary" }], config: { providerId: "test" }, toolPolicies: {} }),
		/valid replacement session/,
	)
	assert.deepEqual(fixture.calls.slice(1), [])
})

test("SDK session adapter preserves the source session when model summarization fails", async () => {
	const fixture = createAdapter({}, { summarizeCompaction: async () => { throw new Error("summary failed") } })
	await assert.rejects(
		() => fixture.adapter.compact({ sourceSessionId: "source", cwd: "C:\\workspace", initialMessages: [{ role: "user", content: "important context" }], config: { providerId: "test", modelId: "model" }, toolPolicies: {} }),
		/summary failed/,
	)
	assert.deepEqual(fixture.calls, [])
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
