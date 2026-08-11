const assert = require("node:assert/strict")
const test = require("node:test")
const { buildScheduledAgentSpec, getScheduledSpecId, parseLooseKeyValueSpec, prependScheduledRun } = require("../dist/features/scheduledAgents/ScheduledAgentPolicy")

test("scheduled agent policy normalizes specs and bounds run history", () => {
	assert.equal(getScheduledSpecId({ name: "Daily Review.md" }), "Daily-Review")
	assert.deepEqual(parseLooseKeyValueSpec("---\nname: Review\ncron: '0 9 * * *'\n---\nPrompt"), { name: "Review", cron: "0 9 * * *" })
	assert.deepEqual(buildScheduledAgentSpec({}, { name: "Review", prompt: "Check" }, "daily", "now"), { id: "daily", name: "Review", description: "", schedule: "", prompt: "Check", enabled: true, updatedAt: "now" })
	assert.equal(prependScheduledRun(Array.from({ length: 30 }, (_, index) => ({ index })), { status: "ok" }, "run-1").length, 25)
})
