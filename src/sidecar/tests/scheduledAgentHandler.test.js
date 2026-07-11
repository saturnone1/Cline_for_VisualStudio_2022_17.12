const assert = require("node:assert/strict")
const test = require("node:test")
const { ScheduledAgentHandler } = require("../dist/features/scheduledAgents/ScheduledAgentHandler")

function fixture(enabled = true, initialSpecs = []) {
	const specs = [...initialSpecs]
	const runs = []
	const store = {
		listSpecs: () => [...specs],
		saveSpec: (_root, request) => { const spec = { id: request.id || request.name, ...request }; specs.push(spec); return spec },
		deleteSpec: (_root, id) => { const index = specs.findIndex((item) => item.id === id); if (index < 0) return false; specs.splice(index, 1); return true },
		listRuns: () => [...runs],
		appendRun: (run) => { const saved = { runId: `run-${runs.length + 1}`, ...run }; runs.unshift(saved); return saved },
		specSource: (root) => `${root}/.cline/cron`,
	}
	return { handler: new ScheduledAgentHandler(store, () => enabled), specs, runs }
}

test("scheduled agent handler projects local specs and enablement", () => {
	const { handler } = fixture(false, [{ id: "daily", prompt: "Review" }])
	const result = handler.list("C:/repo")
	assert.equal(result.items.length, 1)
	assert.equal(result.automationEnabled, false)
	assert.match(result.message, /disabled/)
	assert.equal(result.source, "C:/repo/.cline/cron")
})

test("scheduled agent handler saves and deletes specs through its store", () => {
	const { handler } = fixture()
	assert.equal(handler.save({ id: "daily", prompt: "Review" }, "C:/repo").spec.id, "daily")
	const deleted = handler.delete({ id: "daily" }, "C:/repo")
	assert.equal(deleted.deleted, true)
	assert.equal(deleted.items.length, 0)
})

test("scheduled agent handler launches an existing spec and records the manual run", async () => {
	const { handler, runs } = fixture(true, [{ id: "daily", name: "Daily", prompt: "Review changes" }])
	const launches = []
	const result = await handler.run({ id: "daily" }, "C:/repo", async (request) => launches.push(request))
	assert.deepEqual(launches[0], { text: "Review changes", workspacePath: "C:/repo", taskSessionId: "run-1" })
	assert.equal(result.run.manual, true)
	assert.equal(runs.length, 1)
})

test("scheduled agent handler rejects missing workspaces and empty prompts", async () => {
	const { handler } = fixture()
	assert.throws(() => handler.save({ id: "daily" }, ""), /No workspace/)
	await assert.rejects(() => handler.run({ id: "empty" }, "C:/repo", async () => {}), /does not contain a prompt/)
})
