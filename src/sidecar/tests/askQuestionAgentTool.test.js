const assert = require("node:assert/strict")
const test = require("node:test")
const { createAskQuestionAgentTool } = require("../dist/infrastructure/sdk/AskQuestionAgentTool")

test("LIG VS question tool accepts all distinct options without an arbitrary maximum", async () => {
	let received
	const tool = createAskQuestionAgentTool(async (question, options) => {
		received = { question, options }
		return options[5]
	})
	const options = ["one", "two", "three", "four", "five", "six"]

	assert.equal(tool.name, "ask_question")
	assert.equal(tool.inputSchema.properties.options.maxItems, undefined)
	assert.equal(await tool.execute({ question: "Choose", options }), "six")
	assert.deepEqual(received, { question: "Choose", options })
})

test("LIG VS question tool rejects structurally empty input", async () => {
	const tool = createAskQuestionAgentTool(async () => "unused")
	await assert.rejects(() => tool.execute({ question: " ", options: [] }), /non-empty question/)
})

test("LIG VS question tool propagates the agent cancellation signal", async () => {
	const controller = new AbortController()
	let receivedSignal
	const tool = createAskQuestionAgentTool(async (_question, _options, signal) => {
		receivedSignal = signal
		return "selected"
	})

	assert.equal(await tool.execute({ question: "Choose", options: ["one"] }, { signal: controller.signal }), "selected")
	assert.equal(receivedSignal, controller.signal)
	controller.abort()
	await assert.rejects(() => tool.execute({ question: "Choose", options: ["one"] }, { signal: controller.signal }), /cancelled/)
})
