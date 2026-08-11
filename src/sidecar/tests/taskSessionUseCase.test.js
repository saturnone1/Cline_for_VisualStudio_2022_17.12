const assert = require("node:assert/strict")
const test = require("node:test")
const { TaskSessionUseCase } = require("../dist/application/useCases/TaskSessionUseCase")

test("activateAndRead activates before reading the transcript", async () => {
	const calls = []
	const runtime = {
		activateSession: async (sessionId) => { calls.push(["activate", sessionId]); return { id: sessionId } },
		readMessages: async (request) => { calls.push(["read", request.sessionId]); return [{ text: "hello" }] },
	}
	const useCase = new TaskSessionUseCase(runtime)

	const result = await useCase.activateAndRead("session-1")
	assert.deepEqual(calls, [["activate", "session-1"], ["read", "session-1"]])
	assert.deepEqual(result, { session: { id: "session-1" }, messages: [{ text: "hello" }] })
})

test("load reads metadata before messages without activating the session", async () => {
	const calls = []
	const runtime = {
		getSession: async (request) => { calls.push(["get", request.sessionId]); return { id: request.sessionId } },
		readMessages: async (request) => { calls.push(["read", request.sessionId]); return [] },
	}
	const useCase = new TaskSessionUseCase(runtime)

	await useCase.load("session-2")
	assert.deepEqual(calls, [["get", "session-2"], ["read", "session-2"]])
})
