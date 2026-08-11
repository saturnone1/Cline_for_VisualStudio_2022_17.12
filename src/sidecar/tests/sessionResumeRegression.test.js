const assert = require("node:assert/strict")
const test = require("node:test")
const { TaskLifecycleUseCase } = require("../dist/application/useCases/TaskLifecycleUseCase")
const { ResumeSessionFlow } = require("../dist/features/chat/runtime/ResumeSessionFlow")
const { SendOrResumeSessionFlow } = require("../dist/features/chat/runtime/SendOrResumeSessionFlow")
const { TaskSessionCoordinator } = require("../dist/features/runtime/TaskSessionCoordinator")
const { AgentRuntimeEventDispatcher } = require("../dist/features/runtime/AgentRuntimeEventDispatcher")
const { WebviewRuntimeEventIngress } = require("../dist/infrastructure/webview/WebviewRuntimeEventIngress")
const { SendUserMessageFlow } = require("../dist/features/chat/sendMessage/SendUserMessageFlow")
const { buildResumedConversationContext, clineMessageToResumedTranscriptEntry } = require("../dist/infrastructure/conversation/ResumedConversationProjection")

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
		activeConnectionRevision: () => 0, connectionRevision: () => 0, syncConnection: async () => {}, markConnectionRevisionActive: () => {},
		requiresReplacement: () => false,
		bindSession: () => {},
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

test("activating an existing selected session rebinds sidecar ownership before sending", async () => {
	const calls = []
	const engine = {
		status: { activeSessionId: "stale-active" },
		activateSession: async (sessionId) => { calls.push(["activate", sessionId]); engine.status.activeSessionId = sessionId; return { sessionId } },
	}
	const flow = new SendOrResumeSessionFlow(() => engine, {
		activeSettingsRevision: () => 0, settingsRevision: () => 0, activeConnectionRevision: () => 0, connectionRevision: () => 0, syncConnection: async () => {}, markConnectionRevisionActive: () => {}, requiresReplacement: () => false,
		bindSession: (sessionId) => calls.push(["bind", sessionId]),
		markClosing: () => {}, send: async (command) => { calls.push(["send", command.sessionId]); return { sessionId: command.sessionId } },
		resume: async () => { throw new Error("must not resume an existing session") },
		markSend: () => {}, markError: () => {}, isSessionNotFound: () => false, log: () => {},
	})

	await flow.execute("selected-history", { sessionId: "selected-history", prompt: "continue" }, 8)
	assert.deepEqual(calls, [["activate", "selected-history"], ["bind", "selected-history"], ["send", "selected-history"]])
})

test("connection settings are synchronized on the same idle session before its next message", async () => {
	const calls = []
	let activeConnectionRevision = 1
	const engine = { status: { activeSessionId: "active" }, getSession: async () => ({ sessionId: "active" }) }
	const flow = new SendOrResumeSessionFlow(() => engine, {
		activeSettingsRevision: () => 3, settingsRevision: () => 3,
		activeConnectionRevision: () => activeConnectionRevision, connectionRevision: () => 2,
		syncConnection: async (sessionId) => calls.push(["connection", sessionId]),
		markConnectionRevisionActive: () => { activeConnectionRevision = 2 },
		requiresReplacement: () => false, bindSession: () => {}, markClosing: () => {},
		send: async (command) => { calls.push(["send", command.sessionId]); return { sessionId: command.sessionId } },
		resume: async () => { throw new Error("connection-only settings must not replace the session") },
		markSend: () => {}, markError: () => {}, isSessionNotFound: () => false, log: () => {},
	})

	await flow.execute("active", { sessionId: "active", prompt: "continue" }, 8)
	assert.deepEqual(calls, [["connection", "active"], ["send", "active"]])
	assert.equal(activeConnectionRevision, 2)
})

test("a legacy resumed session is replaced before it can receive another message", async () => {
	const calls = []
	const engine = {
		status: { activeSessionId: "other" },
		activateSession: async () => ({ sessionId: "legacy", metadata: { ligVsResumed: true } }),
		getSession: async () => { throw new Error("activated session should be reused") },
		stop: async ({ sessionId }) => calls.push(["stop", sessionId]),
	}
	const flow = new SendOrResumeSessionFlow(() => engine, {
		activeSettingsRevision: () => 0, settingsRevision: () => 0, activeConnectionRevision: () => 0, connectionRevision: () => 0, syncConnection: async () => {}, markConnectionRevisionActive: () => {}, requiresReplacement: () => false,
		bindSession: () => {}, markClosing: () => {}, send: async () => { throw new Error("legacy session must not receive a send") },
		resume: async (sessionId) => { calls.push(["resume", sessionId]); return { sessionId: "replacement" } },
		markSend: () => {}, markError: () => {}, isSessionNotFound: () => false, log: () => {},
	})
	const result = await flow.execute("legacy", { sessionId: "legacy", prompt: "continue" }, 8)
	assert.equal(result.sessionId, "replacement")
	assert.deepEqual(calls, [["stop", "legacy"], ["resume", "legacy"]])
})

test("a transient session format inspection failure does not block a normal send", async () => {
	let sends = 0
	const engine = {
		status: { activeSessionId: "active" },
		getSession: async () => { throw new Error("temporary metadata failure") },
	}
	const flow = new SendOrResumeSessionFlow(() => engine, {
		activeSettingsRevision: () => 0, settingsRevision: () => 0, activeConnectionRevision: () => 0, connectionRevision: () => 0, syncConnection: async () => {}, markConnectionRevisionActive: () => {}, requiresReplacement: () => false,
		bindSession: () => {}, markClosing: () => {}, send: async () => { sends++; return { sessionId: "active" } },
		resume: async () => { throw new Error("must not resume") }, markSend: () => {}, markError: () => {}, isSessionNotFound: () => false, log: () => {},
	})
	await flow.execute("active", { sessionId: "active", prompt: "hello" }, 5)
	assert.equal(sends, 1)
})

test("a quarantined active session is replaced instead of receiving another direct send", async () => {
	let activateCalls = 0
	let sendCalls = 0
	let resumeCalls = 0
	const engine = {
		status: { activeSessionId: "quarantined-session" },
		activateSession: async () => { activateCalls++; return { sessionId: "quarantined-session" } },
	}
	const flow = new SendOrResumeSessionFlow(() => engine, {
		activeSettingsRevision: () => 0,
		settingsRevision: () => 0,
		activeConnectionRevision: () => 0, connectionRevision: () => 0, syncConnection: async () => {}, markConnectionRevisionActive: () => {},
		requiresReplacement: (sessionId) => sessionId === "quarantined-session",
		bindSession: () => {},
		markClosing: () => {},
		send: async () => { sendCalls++; return {} },
		resume: async () => { resumeCalls++; return { sessionId: "replacement-session" } },
		markSend: () => {},
		markError: () => {},
		isSessionNotFound: () => false,
		log: () => {},
	})

	const result = await flow.execute("quarantined-session", { sessionId: "quarantined-session", prompt: "retry" }, 5)
	assert.equal(result.sessionId, "replacement-session")
	assert.equal(activateCalls, 0)
	assert.equal(sendCalls, 0)
	assert.equal(resumeCalls, 1)
})

test("a user message targets the selected history task instead of a stale active session", async () => {
	const sends = []
	const projectedMessages = []
	const flow = new SendUserMessageFlow({
		interactions: { hasPending: () => false, clear: () => {} },
		newTask: { start: async () => { throw new Error("must not start a new task") } },
		lifecycle: { startLatency: () => {}, transitionStarting: () => {}, nextGeneration: () => 1, currentGeneration: () => 1 },
		projection: { addUserMessage: (...args) => { projectedMessages.push(args); return {} }, showPreparing: () => {}, persist: () => {}, publishPartial: () => {}, broadcast: () => {} },
		attachments: { normalizeImages: async () => [] },
		hooks: { onPrompt: () => {} },
		agent: {
			send: async (sessionId) => { sends.push(sessionId); return { sessionId } },
			resultSessionId: (result, fallback) => result.sessionId || fallback,
			complete: async () => {}, recover: async () => {},
		},
		log: () => {},
	})

	await flow.execute({ requestId: "request-1", prompt: "continue", transcriptText: "continue", images: [], files: [], mode: "act", activeSessionId: "stale-active", selectedSessionId: "selected-history" })
	await new Promise((resolve) => setImmediate(resolve))
	assert.deepEqual(sends, ["selected-history"])
	assert.deepEqual(projectedMessages, [["continue", [], []]])
})

test("a continued task projects attachment UI data without exposing the transport envelope", async () => {
	const projectedMessages = []
	const flow = new SendUserMessageFlow({
		interactions: { hasPending: () => false, clear: () => {} },
		newTask: { start: async () => { throw new Error("must not start a new task") } },
		lifecycle: { startLatency: () => {}, transitionStarting: () => {}, nextGeneration: () => 1, currentGeneration: () => 1 },
		projection: { addUserMessage: (...args) => { projectedMessages.push(args); return {} }, showPreparing: () => {}, persist: () => {}, publishPartial: () => {}, broadcast: () => {} },
		attachments: { normalizeImages: async (images) => images.map(() => "data:image/png;base64,AAAA") },
		hooks: { onPrompt: () => {} },
		agent: {
			send: async (sessionId) => ({ sessionId }), resultSessionId: (result, fallback) => result.sessionId || fallback,
			complete: async () => {}, recover: async () => {},
		},
		log: () => {},
	})

	await flow.execute({ requestId: "request-2", prompt: "이 파일을 검토해", transcriptText: "이 파일을 검토해\n\nAttachments:\nImage: [attached image/png]\nFile: README.md", images: ["C:\\image.png"], files: ["README.md"], mode: "act", activeSessionId: "session", selectedSessionId: "session" })
	assert.deepEqual(projectedMessages, [["이 파일을 검토해", ["C:\\image.png"], ["README.md"]]])
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
		buildContext: () => "[Previous user]\n이전 대화",
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
	assert.equal(calls[1][1].sessionMetadata.ligVsResumedContext, "[Previous user]\n이전 대화")
	assert.equal(calls[1][1].sessionMetadata.ligVsResumeFormatVersion, 2)
	assert.equal(calls[1][1].initialMessages, undefined)
})

test("resumed context is historical metadata and browser results are not confused with actions", () => {
	const messages = [
		{ type: "say", say: "user_feedback", text: "GitHub를 열어줘" },
		{ type: "say", say: "browser_action", text: '{"action":"launch"}' },
		{ type: "say", say: "browser_action_result", text: '{"status":"ok","currentUrl":"https://github.com"}' },
		{ type: "say", say: "text", text: "GitHub를 열었습니다." },
		{ type: "say", say: "user_feedback", text: "다시 해봐" },
	]
	const context = buildResumedConversationContext(messages, "다시 해봐")

	assert.equal(clineMessageToResumedTranscriptEntry(messages[1]), null)
	assert.equal(clineMessageToResumedTranscriptEntry(messages[2]).role, "Tool")
	assert.match(context, /Previous user/)
	assert.match(context, /Tool result:/)
	assert.doesNotMatch(context, /\{"action":"launch"\}/)
	assert.doesNotMatch(context, /다시 해봐/)
})

test("only the confirmed replacement session rebinds task ownership", () => {
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
	coordinator.completeReplacement("replacement-session")
	assert.equal(currentTask.id, "replacement-session")
	assert.equal(coordinator.shouldIgnoreEvent("replacement-session"), false)
	assert.deepEqual(rebound, [
		["snapshot", "history-session", "replacement-session"],
		["history", "history-session", "replacement-session"],
		["latency", "history-session", "replacement-session"],
	])
})

test("a failed replacement preserves a source session that was already quarantined", () => {
	let currentTask = { id: "quarantined-session", task: "retry" }
	const lifecycle = new TaskLifecycleUseCase()
	const coordinator = new TaskSessionCoordinator({
		lifecycle,
		logger: { log: () => {} },
		activeSessionId: () => "quarantined-session",
		currentTask: () => currentTask,
		writeCurrentTask: (task) => { currentTask = task },
		isDeleted: () => false,
		rebindHistory: () => {},
		rebindSnapshot: () => {},
		rebindLatency: () => {},
		writeLifecycleStatus: () => {},
	})
	coordinator.initialize("failed")
	coordinator.markClosing("quarantined-session")
	coordinator.beginReplacement("quarantined-session")
	coordinator.cancelReplacement()

	assert.equal(coordinator.isClosing("quarantined-session"), true)
	assert.equal(coordinator.shouldIgnoreEvent("quarantined-session"), true)
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

test("replacement ingress buffers early events and replays only the confirmed session", () => {
	const projected = []
	const dispatcher = new AgentRuntimeEventDispatcher({
		transitionStreaming: () => {},
		shouldIgnore: () => false,
		markFirstEvent: () => {},
		projectAgent: () => {},
		trackWorkspaceChange: () => {},
		projectChunk: () => {},
		projectSnapshot: () => {},
		projectAuxiliary: () => {},
		projectLifecycle: (event) => { projected.push(event.sessionId) },
		log: () => {},
		activeSessionId: () => "",
		currentTaskId: () => "history-session",
	})
	const ingress = new WebviewRuntimeEventIngress({ log: () => {} }, dispatcher)
	ingress.beginReplacement("history-session")
	ingress.handle({ type: "ended", sessionId: "stale-session", reason: "completed" })
	ingress.handle({ type: "ended", sessionId: "replacement-session", reason: "completed" })
	assert.deepEqual(projected, [])
	ingress.completeReplacement("replacement-session")
	assert.deepEqual(projected, ["replacement-session"])
})

test("ignored stale events cannot change the current task lifecycle", () => {
	let transitions = 0
	const dispatcher = new AgentRuntimeEventDispatcher({
		transitionStreaming: () => { transitions++ },
		shouldIgnore: (sessionId) => sessionId === "stale-session",
		markFirstEvent: () => {}, projectAgent: () => {}, trackWorkspaceChange: () => {}, projectChunk: () => {},
		projectSnapshot: () => {}, projectAuxiliary: () => {}, projectLifecycle: () => {}, log: () => {},
		activeSessionId: () => "current-session", currentTaskId: () => "current-session",
	})
	dispatcher.handle({ type: "chunk", sessionId: "stale-session", chunk: { type: "text", text: "late" } })
	assert.equal(transitions, 0)
})

test("stale workspace changes are not attributed to the current session", () => {
	let tracked = 0
	const dispatcher = new AgentRuntimeEventDispatcher({
		transitionStreaming: () => {}, shouldIgnore: (sessionId) => sessionId === "stale-session", markFirstEvent: () => {}, projectAgent: () => {},
		trackWorkspaceChange: () => { tracked++ }, projectChunk: () => {}, projectSnapshot: () => {}, projectAuxiliary: () => {}, projectLifecycle: () => {},
		log: () => {}, activeSessionId: () => "current-session", currentTaskId: () => "current-session",
	})
	dispatcher.handle({ type: "vscline_file_changed", sessionId: "stale-session", change: { filePath: "old.cs" }, payload: { sessionId: "stale-session" } })
	dispatcher.handle({ type: "vscline_file_changed", sessionId: "", change: { filePath: "unowned.cs" }, payload: {} })
	dispatcher.handle({ type: "vscline_file_changed", sessionId: "current-session", change: { filePath: "current.cs" }, payload: { sessionId: "current-session" } })
	assert.equal(tracked, 1)
})

test("unscoped unknown SDK events cannot make an idle task appear active", () => {
	let transitions = 0
	const logs = []
	const dispatcher = new AgentRuntimeEventDispatcher({
		transitionStreaming: () => { transitions++ }, shouldIgnore: () => false, markFirstEvent: () => {}, projectAgent: () => {}, trackWorkspaceChange: () => {},
		projectChunk: () => {}, projectSnapshot: () => {}, projectAuxiliary: () => {}, projectLifecycle: () => {},
		log: (event) => logs.push(event), activeSessionId: () => "current-session", currentTaskId: () => "current-session",
	})
	dispatcher.handle({ type: "unknown", originalType: "sdk_global_notice", payload: {} })
	assert.equal(transitions, 0)
	assert.deepEqual(logs, ["ignoredUnscopedSdkEvent"])
})
