const assert = require("node:assert/strict")
const test = require("node:test")
const { ContextOverflowRecoveryFlow } = require("../dist/features/chat/runtime/ContextOverflowRecoveryFlow")

const input = {
	requestId: "request-1",
	prompt: "continue",
	transcriptText: "continued conversation",
	images: ["image.png"],
	files: ["notes.txt"],
	mode: "act",
	activeSessionId: "source-session",
	selectedSessionId: "source-session",
}

test("context overflow recovery compacts and retries through the normal send boundary", async () => {
	const calls = []
	const flow = new ContextOverflowRecoveryFlow({
		compact: async (requestId, transcript) => { calls.push(["compact", requestId, transcript]); return "replacement-session" },
		nextGeneration: () => 4,
		transitionStarting: () => calls.push(["starting"]),
		showRetrying: () => calls.push(["progress"]),
		broadcast: async () => calls.push(["broadcast"]),
		normalizeImages: async () => ["data:image/png;base64,AA=="],
		send: async (sessionId, command, textLength) => { calls.push(["send", sessionId, command, textLength]); return { sessionId, result: { text: "done" } } },
		resultSessionId: (result, fallback) => result.sessionId || fallback,
		complete: async (_result, sessionId, generation) => calls.push(["complete", sessionId, generation]),
		recover: async () => calls.push(["recover"]),
		log: (event) => calls.push(["log", event]),
	})

	assert.equal(await flow.execute(input, 3, new Error("maximum context length exceeded")), true)
	assert.deepEqual(calls.find((call) => call[0] === "send").slice(1, 3), ["replacement-session", {
		sessionId: "replacement-session",
		prompt: "continue",
		mode: "act",
		userImages: ["data:image/png;base64,AA=="],
		userFiles: ["notes.txt"],
	}])
	assert.deepEqual(calls.at(-1), ["complete", "replacement-session", 4])
})

test("unrelated failures are not treated as context overflow", async () => {
	let compacted = false
	const flow = new ContextOverflowRecoveryFlow({
		compact: async () => { compacted = true; return "replacement-session" },
		nextGeneration: () => 1,
		transitionStarting: () => {},
		showRetrying: () => {},
		broadcast: async () => {},
		normalizeImages: async () => [],
		send: async () => ({}),
		resultSessionId: (_result, fallback) => fallback,
		complete: async () => {},
		recover: async () => {},
		log: () => {},
	})

	assert.equal(await flow.execute(input, 1, new Error("network unavailable")), false)
	assert.equal(compacted, false)
})
