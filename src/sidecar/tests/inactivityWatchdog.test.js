const assert = require("node:assert/strict")
const test = require("node:test")
const { InactivityWatchdog } = require("../dist/application/services/InactivityWatchdog")

test("inactivity watchdog checks once before declaring a stalled operation", async () => {
	const events = []
	const watchdog = new InactivityWatchdog({
		inactivityMs: 25,
		graceChecks: 1,
		onWaiting: () => events.push("waiting"),
		onTimeout: () => events.push("timeout"),
	}).start()
	try {
		await waitFor(() => events.length >= 1)
		assert.deepEqual(events, ["waiting"])
		await waitFor(() => events.length >= 2)
		assert.deepEqual(events, ["waiting", "timeout"])
	} finally {
		watchdog.dispose()
	}
})

test("observed activity restarts the inactivity checks", async () => {
	const events = []
	const watchdog = new InactivityWatchdog({
		inactivityMs: 30,
		graceChecks: 1,
		onWaiting: () => events.push("waiting"),
		onTimeout: () => events.push("timeout"),
	}).start()
	try {
		await wait(20)
		watchdog.touch()
		await wait(20)
		assert.deepEqual(events, [])
		await waitFor(() => events.length >= 1)
		assert.deepEqual(events, ["waiting"])
	} finally {
		watchdog.dispose()
	}
})

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

async function waitFor(predicate, timeoutMs = 500) {
	const deadline = Date.now() + timeoutMs
	while (!predicate() && Date.now() < deadline) await wait(5)
}
