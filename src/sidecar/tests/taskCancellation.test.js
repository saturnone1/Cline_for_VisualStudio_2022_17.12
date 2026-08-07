const assert = require("node:assert/strict")
const test = require("node:test")
const { TaskCancellationCoordinator } = require("../dist/features/runtime/TaskCancellationCoordinator")
const { CancelTaskFlow } = require("../dist/features/chat/cancelTask/CancelTaskFlow")
const { CancelTaskHandler } = require("../dist/features/chat/cancelTask/CancelTaskHandler")
const { ClearTaskHandler } = require("../dist/features/chat/clearTask/ClearTaskHandler")
const { createTaskCancellationComposition } = require("../dist/infrastructure/webview/TaskCancellationComposition")

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
		cancelWork: async () => ({ succeeded: false, completed: ["agent-and-mcp"], failures: [{ name: "terminal", reason: "alive", timedOut: false }] }),
		clearProjection: () => undefined,
		addCancellationMarker: () => messages.push({ kind: "cancelled" }),
		addError: (text) => messages.push({ kind: "error", text }),
		updateTask: () => undefined,
		runHook: async () => undefined,
		completeCancel: () => { status = "idle" },
		failCancellation: () => { status = "failed" },
		quarantineSession: () => undefined,
		broadcast: async () => undefined,
		log: () => undefined,
	})
	await flow.execute()
	assert.equal(status, "failed")
	assert.equal(generations, 1)
	assert.equal(messages.some((message) => message.kind === "cancelled"), false)
	assert.equal(messages.some((message) => message.kind === "error" && message.text.includes("terminal: alive")), true)
})

test("task cancellation proceeds when the cancelling-state broadcast fails", async () => {
	let status = "streaming"
	let cancelCalls = 0
	let broadcasts = 0
	const logged = []
	const flow = new CancelTaskFlow({
		beginCancel: () => { status = "cancelling"; return true },
		currentStatus: () => status,
		advanceRunGeneration: () => undefined,
		hookSessionId: () => "session-1",
		activeSessionId: () => "session-1",
		cancelWork: async () => { cancelCalls++; return { succeeded: true, completed: ["agent"], failures: [] } },
		clearProjection: () => undefined,
		addCancellationMarker: () => undefined,
		addError: () => undefined,
		updateTask: () => undefined,
		runHook: async () => undefined,
		completeCancel: () => { status = "idle" },
		failCancellation: () => { status = "failed" },
		quarantineSession: () => undefined,
		broadcast: async () => { if (broadcasts++ === 0) throw new Error("webview disconnected") },
		log: (event) => { logged.push(event) },
	})

	await flow.execute()
	assert.equal(cancelCalls, 1)
	assert.equal(status, "idle")
	assert.equal(logged.includes("cancelStateBroadcastFailed"), true)
})

test("successful cancellation projects one canonical marker and ignores a duplicate request", async () => {
	let status = "streaming"
	let releaseCancellation
	let markers = 0
	const flow = new CancelTaskFlow({
		beginCancel: () => {
			if (status !== "streaming") return false
			status = "cancelling"
			return true
		},
		currentStatus: () => status,
		advanceRunGeneration: () => undefined,
		hookSessionId: () => "session-1",
		activeSessionId: () => "session-1",
		cancelWork: () => new Promise((resolve) => { releaseCancellation = () => resolve({ succeeded: true, completed: ["agent"], failures: [] }) }),
		clearProjection: () => undefined,
		addCancellationMarker: () => { markers++ },
		addError: () => undefined,
		updateTask: () => undefined,
		runHook: async () => undefined,
		completeCancel: () => { status = "idle" },
		failCancellation: () => { status = "failed" },
		quarantineSession: () => undefined,
		broadcast: async () => undefined,
		log: () => undefined,
	})

	const first = flow.execute()
	await new Promise((resolve) => setImmediate(resolve))
	await flow.execute()
	releaseCancellation()
	await first

	assert.equal(status, "idle")
	assert.equal(markers, 1)
})

test("task cancellation releases pending user interaction alongside owned work", async () => {
	const cancelled = []
	const cancel = createTaskCancellationComposition({
		abortAgent: async () => { cancelled.push("agent") },
		cancelTerminal: async () => { cancelled.push("terminal") },
		cancelHooks: async () => { cancelled.push("hooks") },
		cancelBrowser: async () => { cancelled.push("browser") },
		cancelInteraction: async () => { cancelled.push("interaction") },
		timeoutMs: () => 100,
		log: () => undefined,
	})

	const result = await cancel("session-1")
	assert.equal(result.succeeded, true)
	assert.deepEqual(new Set(cancelled), new Set(["agent", "terminal", "hooks", "browser", "interaction"]))
})

test("a failed cancellation hook cannot leave a successfully cancelled task stuck", async () => {
	const events = []
	let status = "streaming"
	let broadcasts = 0
	const flow = new CancelTaskFlow({
		beginCancel: () => { status = "cancelling"; return true },
		currentStatus: () => status,
		advanceRunGeneration: () => undefined,
		hookSessionId: () => "session-1",
		activeSessionId: () => "session-1",
		cancelWork: async () => ({ succeeded: true, completed: ["agent-and-mcp", "terminal", "hooks", "browser"], failures: [] }),
		clearProjection: () => undefined,
		addCancellationMarker: () => undefined,
		addError: () => undefined,
		updateTask: () => undefined,
		runHook: async () => { throw new Error("hook failed") },
		completeCancel: () => { status = "idle" },
		failCancellation: () => { status = "failed" },
		quarantineSession: () => undefined,
		broadcast: async () => { broadcasts++ },
		log: (event, details) => events.push({ event, details }),
	})

	await flow.execute()
	assert.equal(status, "idle")
	assert.equal(broadcasts, 2)
	assert.equal(events.some(({ event }) => event === "cancelHookFailed"), true)
})

test("a timed-out cancellation quarantines the old run instead of restoring streaming", async () => {
	let status = "streaming"
	let generations = 0
	let quarantined = ""
	const flow = new CancelTaskFlow({
		beginCancel: () => { status = "cancelling"; return true },
		currentStatus: () => status,
		advanceRunGeneration: () => { generations++ },
		hookSessionId: () => "session-1",
		activeSessionId: () => "session-1",
		cancelWork: async () => ({ succeeded: false, completed: [], failures: [{ name: "agent", reason: "timeout", timedOut: true }] }),
		clearProjection: () => undefined,
		addCancellationMarker: () => undefined,
		addError: () => undefined,
		updateTask: () => undefined,
		runHook: async () => undefined,
		completeCancel: () => { status = "idle" },
		failCancellation: () => { status = "failed" },
		quarantineSession: (sessionId) => { quarantined = sessionId },
		broadcast: async () => undefined,
		log: () => undefined,
	})

	await flow.execute()
	assert.equal(status, "failed")
	assert.equal(generations, 1)
	assert.equal(quarantined, "session-1")
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

test("leaving a task waits for bounded cancellation before clearing the visible session", async () => {
	let cleared = false
	let closing = false
	let status = "streaming"
	let generations = 0
	let releaseCancellation
	const cancellationStarted = new Promise((resolve) => { releaseCancellation = resolve })
	const handler = new ClearTaskHandler(() => null, {
		transition: (next) => { status = next },
		currentStatus: () => status,
		advanceRunGeneration: () => { generations++ },
		currentSessionId: () => "session-1",
		isClosing: () => false,
		markClosing: (_sessionId, value = true) => { closing = value },
		cancelWork: async () => {
			assert.equal(cleared, false)
			await cancellationStarted
			return { succeeded: false, completed: ["agent-and-mcp"], failures: [{ name: "hook", reason: "alive", timedOut: false }] }
		},
		rememberSnapshot: () => undefined,
		clearProjection: () => { cleared = true },
		clearInteractions: () => undefined,
		clearTaskState: () => { cleared = true },
		resetLifecycle: () => { status = "idle" },
		persist: () => undefined,
		broadcast: async () => undefined,
		log: () => undefined,
	})
	const execution = handler.execute()
	await new Promise((resolve) => setImmediate(resolve))
	assert.equal(cleared, false)
	assert.equal(status, "cancelling")
	releaseCancellation()
	await execution
	assert.equal(cleared, true)
	assert.equal(closing, true)
	assert.equal(status, "idle")
	assert.equal(generations, 1)
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
		isClosing: () => false,
		markClosing: () => undefined,
		cancelWork: async () => { cancelCalls++; return { succeeded: true, completed: [], failures: [] } },
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

test("leaving a quarantined failed task retries active-work cancellation", async () => {
	let cancelCalls = 0
	let status = "failed"
	const handler = new ClearTaskHandler(() => null, {
		transition: (next) => { status = next },
		currentStatus: () => status,
		advanceRunGeneration: () => undefined,
		currentSessionId: () => "session-1",
		isClosing: () => true,
		markClosing: () => undefined,
		cancelWork: async () => { cancelCalls++; return { succeeded: true, completed: [], failures: [] } },
		rememberSnapshot: () => undefined,
		clearProjection: () => undefined,
		clearInteractions: () => undefined,
		clearTaskState: () => undefined,
		resetLifecycle: () => { status = "idle" },
		persist: () => undefined,
		broadcast: async () => undefined,
		log: () => undefined,
	})

	await handler.execute()
	assert.equal(cancelCalls, 1)
	assert.equal(status, "idle")
})

test("leaving a task after cancellation timeout keeps the old session quarantined while returning home", async () => {
	let closing = false
	let status = "streaming"
	let generations = 0
	const handler = new ClearTaskHandler(() => null, {
		transition: (next) => { status = next },
		currentStatus: () => status,
		advanceRunGeneration: () => { generations++ },
		currentSessionId: () => "session-1",
		isClosing: () => false,
		markClosing: (_sessionId, value = true) => { closing = value },
		cancelWork: async () => ({ succeeded: false, completed: [], failures: [{ name: "agent", reason: "timeout", timedOut: true }] }),
		rememberSnapshot: () => undefined,
		clearProjection: () => undefined,
		clearInteractions: () => undefined,
		clearTaskState: () => undefined,
		resetLifecycle: () => { status = "idle" },
		persist: () => undefined,
		broadcast: async () => undefined,
		log: () => undefined,
	})

	await handler.execute()
	assert.equal(status, "idle")
	assert.equal(closing, true)
	assert.equal(generations, 1)
})

test("leaving a task contains an unexpected cancellation rejection before returning home", async () => {
	let status = "streaming"
	const logged = []
	const handler = new ClearTaskHandler(() => null, {
		transition: (next) => { status = next },
		currentStatus: () => status,
		advanceRunGeneration: () => undefined,
		currentSessionId: () => "session-1",
		isClosing: () => false,
		markClosing: () => undefined,
		cancelWork: async () => { throw new Error("transport closed") },
		rememberSnapshot: () => undefined,
		clearProjection: () => undefined,
		clearInteractions: () => undefined,
		clearTaskState: () => undefined,
		resetLifecycle: () => { status = "idle" },
		persist: () => undefined,
		broadcast: async () => undefined,
		log: (event) => { logged.push(event) },
	})

	await handler.execute()
	assert.equal(status, "idle")
	assert.deepEqual(logged, ["clearTaskCancellationFailed"])
})

test("a stop request after the run already failed still stops leftover work", async () => {
	// The lifecycle refuses failed -> cancelling, so beginCancel returns false.
	// The request must still reach the cancellation participants instead of being
	// dropped, otherwise the stop button looks dead until it is pressed again.
	const status = "failed"
	let cancelledSessionId = ""
	let generations = 0
	let projectionsCleared = 0
	let markers = 0
	const logged = []
	const flow = new CancelTaskFlow({
		beginCancel: () => false,
		currentStatus: () => status,
		advanceRunGeneration: () => { generations++ },
		hookSessionId: () => "session-1",
		activeSessionId: () => "session-1",
		cancelWork: async (sessionId) => { cancelledSessionId = sessionId; return { succeeded: true, completed: ["terminal"], failures: [] } },
		clearProjection: () => { projectionsCleared++ },
		addCancellationMarker: () => { markers++ },
		addError: () => undefined,
		updateTask: () => undefined,
		runHook: async () => undefined,
		completeCancel: () => undefined,
		failCancellation: () => undefined,
		quarantineSession: () => undefined,
		broadcast: async () => undefined,
		log: (event) => { logged.push(event) },
	})

	await flow.execute()
	assert.equal(cancelledSessionId, "session-1")
	assert.equal(generations, 1)
	// The task reached its own terminal state, so it must not be relabelled cancelled,
	// and clearing the projection would drop the completion_result ask of a task that
	// finished normally.
	assert.equal(markers, 0)
	assert.equal(projectionsCleared, 0)
	assert.deepEqual(logged, ["cancelSettledInactiveTask"])
})

test("a second stop request while already cancelling stays a no-op", async () => {
	let cancelCalls = 0
	const logged = []
	const flow = new CancelTaskFlow({
		beginCancel: () => false,
		currentStatus: () => "cancelling",
		advanceRunGeneration: () => undefined,
		hookSessionId: () => "session-1",
		activeSessionId: () => "session-1",
		cancelWork: async () => { cancelCalls++; return { succeeded: true, completed: [], failures: [] } },
		clearProjection: () => undefined,
		addCancellationMarker: () => undefined,
		addError: () => undefined,
		updateTask: () => undefined,
		runHook: async () => undefined,
		completeCancel: () => undefined,
		failCancellation: () => undefined,
		quarantineSession: () => undefined,
		broadcast: async () => undefined,
		log: (event) => { logged.push(event) },
	})

	await flow.execute()
	assert.equal(cancelCalls, 0)
	assert.deepEqual(logged, ["duplicateCancelIgnored"])
})
