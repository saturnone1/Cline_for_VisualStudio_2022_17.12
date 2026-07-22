const assert = require("node:assert/strict")
const test = require("node:test")
const { TaskCancellationCoordinator } = require("../dist/features/runtime/TaskCancellationCoordinator")
const { CancelTaskFlow } = require("../dist/features/chat/cancelTask/CancelTaskFlow")
const { CancelTaskHandler } = require("../dist/features/chat/cancelTask/CancelTaskHandler")
const { ClearTaskHandler } = require("../dist/features/chat/clearTask/ClearTaskHandler")

test("task cancellation waits for every participant and reports failures", async () => {
	const events = []
	const coordinator = new TaskCancellationCoordinator(() => 100, (event, details) => events.push({ event, details }))
	const result = await coordinator.cancel([
		{ name: "agent", cancel: async () => undefined },
		{ name: "terminal", cancel: async () => { throw new Error("still running") } },
	])
	assert.equal(result.succeeded, false)
	assert.deepEqual(result.completed, ["agent"])
	assert.deepEqual(result.failures, [{ name: "terminal", reason: "still running", timedOut: false }])
	assert.equal(events.at(-1).event, "taskCancellationCompleted")
})

test("task cancellation identifies a participant timeout", async () => {
	const coordinator = new TaskCancellationCoordinator(() => 10, () => undefined)
	const result = await coordinator.cancel([{ name: "hook", cancel: () => new Promise(() => undefined) }])
	assert.equal(result.succeeded, false)
	assert.equal(result.failures[0].name, "hook")
	assert.equal(result.failures[0].timedOut, true)
})

test("cancel flow never projects success when owned work remains", async () => {
	const messages = []
	let status = "streaming"
	let generations = 0
	const flow = new CancelTaskFlow({
		beginCancel: () => { status = "cancelling"; return true },
		currentStatus: () => status,
		advanceRunGeneration: () => { generations++ },
		hookSessionId: () => "session-1",
		activeSessionId: () => "session-1",
		cancelWork: async () => ({ succeeded: false, failures: [{ name: "terminal", reason: "alive", timedOut: false }] }),
		clearProjection: () => undefined,
		addInfo: (text) => messages.push({ kind: "info", text }),
		addError: (text) => messages.push({ kind: "error", text }),
		updateTask: () => undefined,
		runHook: async () => undefined,
		completeCancel: () => { status = "idle" },
		restoreLifecycle: (previous) => { status = previous },
		broadcast: async () => undefined,
		log: () => undefined,
	})
	await assert.rejects(() => flow.execute(), /cancellation operations failed/)
	assert.equal(status, "streaming")
	assert.equal(generations, 0)
	assert.equal(messages.some((message) => message.kind === "info"), false)
	assert.equal(messages.some((message) => message.kind === "error" && message.text.includes("terminal: alive")), true)
})

test("cancel handler marks a session inactive only after SDK abort succeeds", async () => {
	let inactive = 0
	const failing = new CancelTaskHandler({
		abort: async () => { throw new Error("abort failed") },
		markSessionInactive: () => { inactive++ },
	})
	await assert.rejects(() => failing.execute({ sessionId: "session-1" }), /abort failed/)
	assert.equal(inactive, 0)

	const succeeding = new CancelTaskHandler({
		abort: async () => undefined,
		markSessionInactive: () => { inactive++ },
	})
	assert.deepEqual(await succeeding.execute({ sessionId: "session-1" }), { cancelled: true, sessionId: "session-1" })
	assert.equal(inactive, 1)
})

test("leaving a task preserves the visible session when cancellation is incomplete", async () => {
	let cleared = false
	let closing = false
	let status = "streaming"
	let generations = 0
	const handler = new ClearTaskHandler(() => null, {
		transition: (next) => { status = next },
		currentStatus: () => status,
		advanceRunGeneration: () => { generations++ },
		currentSessionId: () => "session-1",
		markClosing: (_sessionId, value = true) => { closing = value },
		cancelWork: async () => ({ succeeded: false, failures: [{ name: "hook", reason: "alive", timedOut: false }] }),
		restoreLifecycle: (previous) => { status = previous },
		addError: () => undefined,
		rememberSnapshot: () => undefined,
		clearProjection: () => { cleared = true },
		clearInteractions: () => undefined,
		clearTaskState: () => { cleared = true },
		resetLifecycle: () => undefined,
		persist: () => undefined,
		broadcast: async () => undefined,
		log: () => undefined,
	})
	await assert.rejects(() => handler.execute(), /could not be cancelled/)
	assert.equal(cleared, false)
	assert.equal(closing, false)
	assert.equal(status, "streaming")
	assert.equal(generations, 0)
})

test("leaving a completed task skips active-work cancellation", async () => {
	let cancelCalls = 0
	let cleared = false
	let status = "completed"
	const handler = new ClearTaskHandler(() => null, {
		transition: (next) => { status = next },
		currentStatus: () => status,
		advanceRunGeneration: () => undefined,
		currentSessionId: () => "session-1",
		markClosing: () => undefined,
		cancelWork: async () => { cancelCalls++; return { succeeded: true, failures: [] } },
		restoreLifecycle: (previous) => { status = previous },
		addError: () => undefined,
		rememberSnapshot: () => undefined,
		clearProjection: () => { cleared = true },
		clearInteractions: () => undefined,
		clearTaskState: () => { cleared = true },
		resetLifecycle: () => { status = "idle" },
		persist: () => undefined,
		broadcast: async () => undefined,
		log: () => undefined,
	})
	await handler.execute()
	assert.equal(cancelCalls, 0)
	assert.equal(cleared, true)
	assert.equal(status, "idle")
})
