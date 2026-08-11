const assert = require("node:assert/strict")
const test = require("node:test")
const { AskResponseInteractionFlow } = require("../dist/features/chat/sendMessage/AskResponseInteractionFlow")

test("answering a pending question restarts activity tracking from the user response", async () => {
	const events = []
	let answer = ""
	const flow = new AskResponseInteractionFlow({
		hasPendingApproval: () => false,
		hasPendingQuestion: () => true,
		takeApproval: () => undefined,
		takeQuestion: () => (value) => { answer = value },
		transitionStreaming: (source) => events.push(["transition", source]),
		noteActivity: (reason) => events.push(["activity", reason]),
		removeFollowup: () => events.push(["remove"]),
		addFeedback: (text) => events.push(["feedback", text]),
		updateTask: () => events.push(["update"]),
		broadcast: async () => { events.push(["broadcast"]) },
		log: () => undefined,
	})

	assert.equal(await flow.handle({ responseType: "messageResponse", text: "두 번째", answerText: "두 번째", images: [], files: [], activeSessionId: "session-1" }), true)
	assert.equal(answer, "두 번째")
	assert.deepEqual(events.slice(0, 2), [["transition", "question-response"], ["activity", "question-response"]])
})
