const assert = require("node:assert/strict")
const test = require("node:test")
const { TaskSnapshotStore } = require("../dist/features/taskHistory/TaskSnapshotStore")
const { TaskStateCoordinator } = require("../dist/features/taskHistory/TaskStateCoordinator")
const { createInitialState, createWebviewStateSnapshot } = require("../dist/infrastructure/webview/WebviewState")

test("updating one task snapshot preserves unchanged snapshot objects", () => {
	const published = []
	const store = new TaskSnapshotStore({ old: { taskItem: { id: "old" }, messages: [{ text: "old message" }] } }, (snapshots) => published.push(snapshots))
	store.remember("current", { id: "current" }, [{ text: "first" }])
	const oldSnapshot = published.at(-1).old
	store.remember("current", { id: "current" }, [{ text: "second" }])

	assert.equal(published.at(-1).old, oldSnapshot)
	assert.equal(published.at(-1).current.messages[0].text, "second")
})

test("live task updates defer full transcript sizing until a stable capture boundary", () => {
	let task = { id: "current", size: 7 }
	let history = []
	const messages = [{ text: "a much longer live message" }]
	const store = new TaskSnapshotStore({}, () => {})
	const coordinator = new TaskStateCoordinator({
		snapshots: store, readCurrentTask: () => task, writeCurrentTask: (value) => { task = value },
		readMessages: () => messages, readHistory: () => history, writeHistory: (value) => { history = value },
		schedulePersist: () => {}, now: () => 10,
	})

	coordinator.update()
	assert.equal(task.size, 7)
	coordinator.capture()
	assert.ok(task.size > 7)
})

test("WebView state excludes persistence-only task snapshots", () => {
	const state = createInitialState()
	state.taskSnapshots = { old: { taskItem: { id: "old" }, messages: [{ text: "private transcript" }] } }
	state.clineMessages = [{ text: "visible transcript" }]
	const projected = createWebviewStateSnapshot(state)

	assert.equal("taskSnapshots" in projected, false)
	assert.deepEqual(projected.clineMessages, state.clineMessages)
})

test("WebView state bounds a long transcript while preserving its compaction anchor and newest messages", () => {
	const state = createInitialState()
	state.currentTaskItem = { id: "long-task" }
	state.clineMessages = Array.from({ length: 700 }, (_, index) => ({ ts: index + 1, type: "say", say: "text", text: `${index}:` + "x".repeat(32 * 1024) }))
	state.clineMessages[50] = { ...state.clineMessages[50], contextCompaction: { summary: "durable anchor" } }

	const projected = createWebviewStateSnapshot(state)
	const serialized = JSON.stringify(projected.clineMessages)
	assert.ok(projected.clineMessages.length < 600)
	assert.equal(projected.clineMessages[0].ts, 1)
	assert.equal(projected.clineMessages.find((message) => message.contextCompaction)?.contextCompaction.summary, "durable anchor")
	assert.equal(projected.clineMessages.at(-1).ts, 700)
	assert.ok(serialized.length < 4.2 * 1024 * 1024, `WebView transcript snapshot was ${serialized.length} chars`)
})
