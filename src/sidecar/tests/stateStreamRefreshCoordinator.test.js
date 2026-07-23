const assert = require("node:assert/strict")
const test = require("node:test")
const { StateStreamRefreshCoordinator } = require("../dist/features/web/StateStreamRefreshCoordinator")

test("a refresh skipped during live activity is retried after the stream becomes quiet", async () => {
	let live = true
	let refreshes = 0
	const coordinator = new StateStreamRefreshCoordinator({
		logger: { log() {} },
		delayMs: () => 5,
		shouldSkipScheduledRefresh: () => live,
		shouldContinueScheduledRefresh: () => true,
		historyRefreshIntervalMs: () => 60_000,
		refreshHistory: async () => {},
		refreshSelectedTask: async () => { refreshes += 1; return false },
		broadcast: async () => {},
		formatError: String,
	})
	coordinator.schedule()
	await wait(12)
	assert.equal(refreshes, 0)
	live = false
	await wait(15)
	coordinator.dispose()
	assert.ok(refreshes >= 1)
})

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }
