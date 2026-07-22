const assert = require("node:assert/strict")
const test = require("node:test")
const { TaskLifecycleUseCase } = require("../dist/application/useCases/TaskLifecycleUseCase")
const { ResumeSessionFlow } = require("../dist/features/chat/runtime/ResumeSessionFlow")
const { SendOrResumeSessionFlow } = require("../dist/features/chat/runtime/SendOrResumeSessionFlow")
const { TaskSessionCoordinator } = require("../dist/features/runtime/TaskSessionCoordinator")
const { AgentRuntimeEventDispatcher } = require("../dist/features/runtime/AgentRuntimeEventDispatcher")

test("a selected history session that is absent from the SDK resumes without a failed send", async () => {
	let sendCalls = 0
	let resumeCalls = 0
	const engine = {
		status: { activeSessionId: null },
		activateSession: async () => null,
	}
	const flow = new SendOrResumeSessionFlow(() => engine, {
		activeSettingsRevision: () => 0,
		settingsRevision: () => 0,
		markClosing: () => {},
		send: async () => { sendCalls++; throw new Error("stale session must not be sent") },
		resume: async () => { resumeCalls++; return { sessionId: "replacement-session" } },
		markSend: () => {},
		markError: () => {},
		isSessionNotFound: (error) => /session not found/i.test(String(error?.message || error)),
		log: () => {},
	})

	const result = await flow.execute("history-session", { sessionId: "history-session", prompt: "안녕" }, 2)
	assert.equal(result.sessionId, "replacement-session")
	assert.equal(sendCalls, 0)
	assert.equal(resumeCalls, 1)
})

test("history resume starts a fresh SDK session and brackets replacement ownership", async () => {
	const calls = []
	const flow = new ResumeSessionFlow({
		isRuntimeAvailable: () => true,
		workspaceRoots: async () => ["C:\\workspace"],
		currentCwd: () => "C:\\workspace",
		prepareTask: () => ({ title: "기존 작업" }),
		noteActivity: () => {},
		updateTask: () => {},
		broadcast: async () => {},
		runResumeHook: () => {},
		buildInitialMessages: () => [{ role: "user", content: "이전 대화" }],
		normalizeImages: async (images) => images,
		buildConfig: async () => ({ providerId: "test", sessionId: undefined }),
		toolPolicies: () => ({}),
		start: async (command) => { calls.push(["start", command]); return { sessionId: "replacement-session" } },
		beginReplacement: (sessionId) => calls.push(["begin", sessionId]),
		completeReplacement: (result) => calls.push(["complete", result.sessionId]),
		cancelReplacement: () => calls.push(["cancel"]),
		markSettingsRevisionActive: () => {},
		log: () => {},
	})

	await flow.execute("history-session", { sessionId: "history-session", prompt: "안녕" }, 2)
	assert.deepEqual(calls.map((entry) => entry[0]), ["begin", "start", "complete"])
	assert.equal(calls[1][1].config.sessionId, undefined)
	assert.equal(calls[1][1].sessionMetadata.ligVsResumedFrom, "history-session")
})

test("the first event from a replacement session rebinds task ownership before projection", () => {
	let currentTask = { id: "history-session", task: "안녕" }
	const rebound = []
	const lifecycle = new TaskLifecycleUseCase()
	const coordinator = new TaskSessionCoordinator({
		lifecycle,
		logger: { log: () => {} },
		activeSessionId: () => "",
		currentTask: () => currentTask,
		writeCurrentTask: (task) => { currentTask = task },
		isDeleted: () => false,
		rebindHistory: (previous, next) => rebound.push(["history", previous, next]),
		rebindSnapshot: (previous, next) => rebound.push(["snapshot", previous, next]),
		rebindLatency: (previous, next) => rebound.push(["latency", previous, next]),
		writeLifecycleStatus: () => {},
	})
	coordinator.initialize("starting")
	coordinator.beginReplacement("history-session")

	assert.equal(coordinator.shouldIgnoreEvent("history-session"), true)
	assert.equal(coordinator.adoptReplacement("replacement-session"), true)
	assert.equal(currentTask.id, "replacement-session")
	assert.equal(coordinator.shouldIgnoreEvent("replacement-session"), false)
	assert.deepEqual(rebound, [
		["snapshot", "history-session", "replacement-session"],
		["history", "history-session", "replacement-session"],
		["latency", "history-session", "replacement-session"],
	])
})

test("a new selected task id is not treated as an active SDK session", () => {
	let currentTask = { id: "pending-task", task: "안녕" }
	let projected = false
	const lifecycle = new TaskLifecycleUseCase()
	const coordinator = new TaskSessionCoordinator({
		lifecycle,
		logger: { log: () => {} },
		activeSessionId: () => "",
		currentTask: () => currentTask,
		writeCurrentTask: (task) => { currentTask = task },
		isDeleted: () => false,
		rebindHistory: () => {},
		rebindSnapshot: () => {},
		rebindLatency: () => {},
		writeLifecycleStatus: () => {},
	})

	coordinator.initialize("starting")

	assert.equal(coordinator.currentSessionId, "")
	const dispatcher = new AgentRuntimeEventDispatcher({
		transitionStreaming: () => {},
		adoptReplacement: (sessionId) => coordinator.adoptReplacement(sessionId),
		shouldIgnore: (sessionId) => coordinator.shouldIgnoreEvent(sessionId),
		markFirstEvent: () => {},
		projectAgent: (_event, sessionId) => { projected = true; coordinator.bindSession(sessionId) },
		trackWorkspaceChange: () => {},
		projectChunk: () => {},
		projectSnapshot: () => {},
		projectAuxiliary: () => {},
		projectLifecycle: () => {},
		log: () => {},
		activeSessionId: () => coordinator.currentSessionId,
		currentTaskId: () => String(currentTask.id || ""),
	})
	dispatcher.handle({ type: "agent_event", sessionId: "sdk-session", event: { type: "text", text: "안녕하세요" } })

	assert.equal(projected, true)
	assert.equal(coordinator.currentSessionId, "sdk-session")
	assert.equal(currentTask.id, "sdk-session")
	assert.equal(coordinator.shouldIgnoreEvent("stale-session"), true)
})

test("a replacement lifecycle event rebinds ownership before completion projection", () => {
	let adopted = false
	let projected = false
	const dispatcher = new AgentRuntimeEventDispatcher({
		transitionStreaming: () => {},
		adoptReplacement: (sessionId) => { adopted = sessionId === "replacement-session"; return adopted },
		shouldIgnore: () => !adopted,
		markFirstEvent: () => {},
		projectAgent: () => {},
		trackWorkspaceChange: () => {},
		projectChunk: () => {},
		projectSnapshot: () => {},
		projectAuxiliary: () => {},
		projectLifecycle: () => { projected = true },
		log: () => {},
		activeSessionId: () => "",
		currentTaskId: () => "history-session",
	})
	dispatcher.handle({ type: "ended", sessionId: "replacement-session", reason: "completed" })
	assert.equal(adopted, true)
	assert.equal(projected, true)
})
