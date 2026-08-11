const assert = require("node:assert/strict")
const test = require("node:test")
const { StartTaskHandler } = require("../dist/features/chat/startTask/StartTaskHandler")
const { CancelTaskHandler } = require("../dist/features/chat/cancelTask/CancelTaskHandler")

test("StartTask slice validates and forwards task startup", async () => {
	const calls = []
	const handler = new StartTaskHandler({ startSession: async (command) => { calls.push(command); return { sessionId: "s1" } } })
	const command = { prompt: "Build it", cwd: "C:\\workspace", interactive: true }
	assert.deepEqual(await handler.execute(command), { sessionId: "s1" })
	assert.deepEqual(calls, [command])
	assert.throws(() => handler.execute({ prompt: " ", cwd: "C:\\workspace" }), /non-empty prompt/)
})

test("CancelTask slice aborts and always marks the session inactive", async () => {
	const calls = []
	const engine = {
		abort: async (command) => { calls.push(["abort", command.sessionId]) },
		markSessionInactive: (sessionId) => calls.push(["inactive", sessionId]),
	}
	const handler = new CancelTaskHandler(engine)
	assert.deepEqual(await handler.execute({ sessionId: "s1" }), { cancelled: true, sessionId: "s1" })
	assert.deepEqual(calls, [["abort", "s1"], ["inactive", "s1"]])
})
