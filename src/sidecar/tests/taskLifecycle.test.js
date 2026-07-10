const assert = require("node:assert/strict")
const test = require("node:test")
const { canTransitionTask, isTerminalTaskStatus } = require("../dist/domain/task/TaskLifecycle")

test("task lifecycle accepts expected streaming and cancellation transitions", () => {
	assert.equal(canTransitionTask("idle", "starting"), true)
	assert.equal(canTransitionTask("starting", "streaming"), true)
	assert.equal(canTransitionTask("streaming", "cancelling"), true)
	assert.equal(canTransitionTask("cancelling", "idle"), true)
	assert.equal(canTransitionTask("idle", "completed"), false)
})

test("terminal SDK statuses remain normalized", () => {
	assert.equal(isTerminalTaskStatus(" Completed "), true)
	assert.equal(isTerminalTaskStatus("streaming"), false)
})
