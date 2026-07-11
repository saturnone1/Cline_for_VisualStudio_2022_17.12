const assert = require("node:assert/strict")
const test = require("node:test")
const { TaskLifecycleUseCase } = require("../dist/application/useCases/TaskLifecycleUseCase")

test("task lifecycle use case reports accepted and rejected transitions", () => {
	const useCase = new TaskLifecycleUseCase()
	assert.deepEqual(useCase.transition("completed", "invalid"), {
		accepted: false,
		previous: "idle",
		current: "idle",
		source: "invalid",
	})
	assert.equal(useCase.transition("starting", "send").accepted, true)
	assert.equal(useCase.transition("streaming", "sdk").accepted, true)
	assert.equal(useCase.transition("cancelling", "cancel").accepted, true)
	assert.equal(useCase.transition("streaming", "late-event").accepted, false)
	assert.equal(useCase.reset("cancelled").current, "idle")
})

test("task lifecycle use case exposes explicit agent session and pending interaction state", () => {
	const useCase = new TaskLifecycleUseCase()
	useCase.bindSession("session-1")
	useCase.transition("starting", "send")
	useCase.transition("awaiting_user", "approval")
	assert.equal(useCase.waitFor("tool_approval"), true)
	assert.deepEqual(useCase.snapshot, {
		sessionId: "session-1",
		phase: "awaiting_user",
		pendingInteraction: "tool_approval",
	})
	useCase.transition("streaming", "approved")
	assert.equal(useCase.snapshot.pendingInteraction, "none")
})
