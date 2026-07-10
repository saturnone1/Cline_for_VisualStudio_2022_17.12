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
