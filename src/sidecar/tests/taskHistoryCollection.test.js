const assert = require("node:assert/strict")
const test = require("node:test")
const { upsertTaskHistoryItem, rebindTaskHistoryId, setTaskHistoryFavorite, removeTaskHistoryItems } = require("../dist/features/taskHistory/TaskHistoryCollection")

test("task history slice owns ordering, identity rebinding, favorites, and removal", () => {
	const initial = [{ id: "a", task: "old" }, { id: "b", task: "second" }]
	const upserted = upsertTaskHistoryItem(initial, { id: "b", task: "new" })
	assert.deepEqual(upserted, [{ id: "b", task: "new" }, { id: "a", task: "old" }])
	const rebound = rebindTaskHistoryId(upserted, "b", "session-b")
	assert.deepEqual(setTaskHistoryFavorite(rebound, "session-b", true)[0], { id: "session-b", task: "new", isFavorited: true })
	assert.deepEqual(removeTaskHistoryItems(rebound, new Set(["a"])), [{ id: "session-b", task: "new" }])
})
