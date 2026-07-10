const assert = require("node:assert/strict")
const test = require("node:test")
const { canTransitionTask, isTerminalTaskStatus, TaskLifecycleMachine } = require("../dist/domain/task/TaskLifecycle")

test("task lifecycle accepts expected streaming and cancellation transitions", () => {
	assert.equal(canTransitionTask("idle", "starting"), true)
	assert.equal(canTransitionTask("starting", "streaming"), true)
	assert.equal(canTransitionTask("streaming", "cancelling"), true)
	assert.equal(canTransitionTask("cancelling", "idle"), true)
	assert.equal(canTransitionTask("idle", "completed"), false)
})

test("task lifecycle machine rejects duplicate cancellation and invalid completion", () => {
	const lifecycle = new TaskLifecycleMachine()
	assert.equal(lifecycle.transition("completed"), false)
	assert.equal(lifecycle.status, "idle")
	assert.equal(lifecycle.transition("starting"), true)
	assert.equal(lifecycle.transition("cancelling"), true)
	assert.equal(lifecycle.transition("cancelling"), false)
	assert.equal(lifecycle.transition("streaming"), false)
	assert.equal(lifecycle.transition("idle"), true)
})

test("terminal SDK statuses remain normalized", () => {
	assert.equal(isTerminalTaskStatus(" Completed "), true)
	assert.equal(isTerminalTaskStatus("streaming"), false)
})
