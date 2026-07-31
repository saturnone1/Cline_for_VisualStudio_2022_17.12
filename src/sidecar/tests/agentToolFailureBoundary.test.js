const assert = require("node:assert/strict")
const test = require("node:test")
const { wrapAgentToolExecutorMap, wrapAgentToolFailureContext } = require("../dist/infrastructure/sdk/AgentToolFailureBoundary")

test("extra tool failures become actionable model-visible errors", async () => {
	const failures = []
	const tool = wrapAgentToolFailureContext({
		name: "browser_action",
		execute: async () => { throw { error: "DevTools endpoint is unavailable", status: 404 } },
	}, "browser_action", (message) => failures.push(message))

	await assert.rejects(() => tool.execute({ action: "launch" }), /Tool "browser_action" failed: DevTools endpoint is unavailable/)
	assert.equal(failures.length, 1)
})

test("built-in executor failures include the executor name", async () => {
	const executors = wrapAgentToolExecutorMap({
		readFile: async () => { throw new Error("file disappeared") },
	})
	await assert.rejects(() => executors.readFile(), /Tool "readFile" failed: file disappeared/)
})

test("cancellation keeps its original AbortError semantics", async () => {
	const cancelled = new Error("Command was cancelled.")
	cancelled.name = "AbortError"
	const tool = wrapAgentToolFailureContext({ name: "bash", execute: async () => { throw cancelled } }, "bash")
	await assert.rejects(() => tool.execute(), (error) => error === cancelled)
})
