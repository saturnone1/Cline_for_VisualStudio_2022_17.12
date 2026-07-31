const assert = require("node:assert/strict")
const test = require("node:test")
const { createAgentMistakeRecoveryPolicy } = require("../dist/application/services/AgentMistakeRecoveryPolicy")

test("repeated tool polling remains a model-visible recovery instead of a host stop", () => {
	const events = []
	const decide = createAgentMistakeRecoveryPolicy((event) => events.push(event))
	const context = (count) => ({ iteration: count, consecutiveMistakes: 3, maxConsecutiveMistakes: 3,
		reason: "tool_execution_failed", details: `Detected ${count} consecutive identical calls to \`mcp-vs2022__build_status\`; stopping to avoid a loop.` })
	const first = decide(context(5))
	const repeated = decide(context(6))

	assert.equal(first.action, "continue")
	assert.match(first.guidance, /Do not repeat the same tool call/)
	assert.match(first.guidance, /respond to the user with the current status/)
	assert.equal(repeated.action, "continue")
	assert.match(repeated.guidance, /Stop using tools for this approach/)
	assert.deepEqual(events, ["agentMistakeRecoveryRequested", "agentMistakeRecoveryRequested"])
})

test("different failing tools receive independent recovery guidance", () => {
	const decide = createAgentMistakeRecoveryPolicy(() => undefined)
	const context = (tool) => ({ iteration: 5, consecutiveMistakes: 3, maxConsecutiveMistakes: 3,
		reason: "tool_execution_failed", details: `Detected 5 consecutive identical calls to \`${tool}\`; stopping to avoid a loop.` })
	assert.equal(decide(context("first_tool")).action, "continue")
	assert.equal(decide(context("second_tool")).action, "continue")
})

test("the same failure can recover again after later successful progress", () => {
	const decide = createAgentMistakeRecoveryPolicy(() => undefined)
	const context = (iteration) => ({ iteration, consecutiveMistakes: 3, maxConsecutiveMistakes: 3,
		reason: "tool_execution_failed", details: "Detected identical calls to `status_tool`." })

	assert.equal(decide(context(5)).action, "continue")
	assert.equal(decide(context(6)).action, "continue")
	assert.equal(decide(context(12)).action, "continue")
})
