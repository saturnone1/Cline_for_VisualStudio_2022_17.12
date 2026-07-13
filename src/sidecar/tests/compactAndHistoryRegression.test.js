const assert = require("node:assert/strict")
const test = require("node:test")
const { TaskRpcHandler } = require("../dist/features/chat/TaskRpcHandler")
const { CompactSessionFlow } = require("../dist/features/chat/runtime/CompactSessionFlow")
const { TaskHistorySync } = require("../dist/features/taskHistory/TaskHistorySync")
const { validateWebviewRpcPayload } = require("../dist/application/dto/generated/WebviewRpcContract")

test("compact and history requests satisfy their WebView RPC contracts", () => {
	assert.deepEqual(validateWebviewRpcPayload("SlashService", "condense", "request", {}), { ok: true })
	assert.deepEqual(
		validateWebviewRpcPayload("TaskService", "getTaskHistory", "request", {
			favoritesOnly: false,
			searchQuery: "old task",
			sortBy: "newest",
			currentWorkspaceOnly: false,
		}),
		{ ok: true },
	)
})

test("task history RPC waits for SDK refresh before returning tasks", async () => {
	const history = []
	const handler = new TaskRpcHandler({
		hasPendingQuestion: () => false,
		hasCurrentTask: () => false,
		start: async () => {}, respond: async () => {}, compact: async () => {}, cancel: async () => {}, clear: async () => {},
		refreshHistory: async () => { await Promise.resolve(); history.push({ id: "remote-1", task: "restored" }) },
		history: () => history,
		show: async () => {}, delete: async () => {}, deleteAll: async () => {}, toggleFavorite: () => {}, broadcast: async () => {},
	})

	assert.deepEqual(await handler.handle({ type: "history" }, "history-request"), {
		payload: { tasks: [{ id: "remote-1", task: "restored" }] },
	})
})

test("SDK history refresh preserves local tasks that are absent from the SDK result", async () => {
	let history = [{ id: "local-1", task: "legacy local task" }]
	const sync = new TaskHistorySync({
		isAvailable: () => true,
		listHistory: async () => [{ sessionId: "remote-1", title: "SDK task" }],
		projectSession: (session) => ({ id: session.sessionId, task: session.title }),
		readHistory: () => history,
		writeHistory: (next) => { history = next },
		broadcast: async () => {},
		log: () => {},
	})

	await sync.refresh()
	assert.deepEqual(history.map((item) => item.id), ["remote-1", "local-1"])
})

test("compact acknowledges immediately and starts a normal session turn instead of steering an inactive run", async () => {
	let command
	let transitioned = false
	let finishSend
	const sendFinished = new Promise((resolve) => { finishSend = resolve })
	const flow = new CompactSessionFlow({
		isRuntimeAvailable: () => true,
		activeSessionId: () => "session-1",
		selectedSessionId: () => "session-1",
		language: () => "ko",
		mode: () => "act",
		addError: () => {},
		transitionStarting: () => { transitioned = true },
		startLatency: () => {},
		showProgress: () => {},
		persist: () => {},
		broadcast: async () => {},
		nextGeneration: () => 1,
		currentGeneration: () => 1,
		send: async (_sessionId, nextCommand) => { command = nextCommand; return sendFinished },
		resultSessionId: () => "session-1",
		complete: async () => {},
		recover: async () => {},
		log: () => {},
	})

	await flow.execute("compact-request")
	await Promise.resolve()
	assert.equal(transitioned, true)
	assert.equal(command.sessionId, "session-1")
	assert.equal(command.delivery, undefined)
	finishSend({ sessionId: "session-1", result: { text: "summary" } })
	await Promise.resolve()
})
