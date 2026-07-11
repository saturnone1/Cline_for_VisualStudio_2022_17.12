const assert = require("node:assert/strict")
const test = require("node:test")
const { SendMessageHandler } = require("../dist/features/chat/sendMessage/SendMessageHandler")

test("SendMessage slice validates and forwards its typed command", async () => {
	const calls = []
	const handler = new SendMessageHandler({ send: async (command) => { calls.push(command); return { accepted: true } } })
	const command = { sessionId: "session-1", prompt: "Hello", mode: "act", userFiles: ["README.md"] }

	assert.deepEqual(await handler.execute(command), { accepted: true })
	assert.deepEqual(calls, [command])
	assert.throws(() => handler.execute({ sessionId: "", prompt: "Hello" }), /session ID/)
	assert.throws(() => handler.execute({ sessionId: "session-1", prompt: " " }), /non-empty prompt/)
})
