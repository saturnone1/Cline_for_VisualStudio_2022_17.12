const assert = require("node:assert/strict")
const test = require("node:test")
const { canTransitionTask, isAgentRunActive, isTerminalTaskStatus, terminalTaskOutcome, TaskLifecycleMachine } = require("../dist/domain/task/TaskLifecycle")

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
	assert.equal(isTerminalTaskStatus("mistake_limit"), true)
	assert.equal(terminalTaskOutcome("mistake_limit"), "failed")
	assert.equal(isTerminalTaskStatus("streaming"), false)
})

test("only model-producing phases are active agent runs", () => {
	assert.equal(isAgentRunActive("starting"), true)
	assert.equal(isAgentRunActive("streaming"), true)
	assert.equal(isAgentRunActive("awaiting_user"), false)
	assert.equal(isAgentRunActive("cancelling"), false)
})
