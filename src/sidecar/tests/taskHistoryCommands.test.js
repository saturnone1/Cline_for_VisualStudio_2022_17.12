const assert = require("node:assert/strict")
const test = require("node:test")
const { TaskHistoryCommands } = require("../dist/features/taskHistory/TaskHistoryCommands")

function createCommands({ history, currentTask = null, deleteRemote }) {
	const state = { history: history.map((item) => ({ ...item })), currentTask, messagesCleared: 0, forgotten: [], persisted: 0 }
	const deleted = new Set()
	const logs = []
	const commands = new TaskHistoryCommands({
		readHistory: () => state.history,
		writeHistory: (value) => { state.history = value },
		readCurrentTask: () => state.currentTask,
		writeCurrentTask: (value) => { state.currentTask = value },
		clearMessages: () => { state.messagesCleared++ },
		clearLiveInteraction: () => undefined,
		markDeleted: (id) => deleted.add(id),
		removeDeleted: (value) => value.filter((item) => !deleted.has(item.id)),
		listRemoteTaskIds: async () => history.map((item) => item.id),
		deleteRemote,
		updateRemoteFavorite: async () => undefined,
		getSnapshot: () => null,
		rememberSnapshot: () => undefined,
		forgetSnapshot: (id) => { state.forgotten.push(id) },
		clearSnapshots: () => undefined,
		persist: () => { state.persisted++ },
		log: (event, details) => logs.push({ event, details }),
	})
	return { commands, state, deleted, logs }
}

test("failed remote deletion preserves local task history and selected task", async () => {
	const fixture = createCommands({
		history: [{ id: "task-1", ts: 1 }],
		currentTask: { id: "task-1", ts: 1 },
		deleteRemote: async () => { throw new Error("storage unavailable") },
	})

	await fixture.commands.delete(["task-1"])

	assert.deepEqual(fixture.state.history.map((item) => item.id), ["task-1"])
	assert.equal(fixture.state.currentTask.id, "task-1")
	assert.deepEqual(fixture.state.forgotten, [])
	assert.equal(fixture.deleted.size, 0)
	assert.equal(fixture.logs.some((entry) => entry.event === "deleteSessionFailed"), true)
})

test("delete all removes only sessions confirmed by the remote store", async () => {
	const fixture = createCommands({
		history: [{ id: "task-1", ts: 1 }, { id: "task-2", ts: 2 }],
		deleteRemote: async (id) => { if (id === "task-2") throw new Error("storage unavailable"); return true },
	})

	await fixture.commands.deleteAll()

	assert.deepEqual(fixture.state.history.map((item) => item.id), ["task-2"])
	assert.deepEqual(fixture.state.forgotten, ["task-1"])
	assert.deepEqual([...fixture.deleted], ["task-1"])
})

test("a session already absent from the remote store is removed locally", async () => {
	const fixture = createCommands({
		history: [{ id: "task-missing", ts: 1 }],
		deleteRemote: async () => false,
	})

	await fixture.commands.delete(["task-missing"])

	assert.deepEqual(fixture.state.history, [])
	assert.deepEqual(fixture.state.forgotten, ["task-missing"])
})
