const assert = require("node:assert/strict")
const test = require("node:test")
const { StartNewTaskFlow } = require("../dist/features/chat/startTask/StartNewTaskFlow")
const { PrepareNewTaskFlow } = require("../dist/features/chat/startTask/PrepareNewTaskFlow")

test("a new task does not replace the visible task when the previous session cannot stop", async () => {
	const mutations = []
	const flow = new StartNewTaskFlow({
		isRuntimeAvailable: () => true,
		stopPrevious: async () => { mutations.push("stop"); throw new Error("stop failed") },
		transitionStarting: () => mutations.push("starting"),
		createTask: () => { mutations.push("create"); return { id: "new-task" } },
		startLatency: () => mutations.push("latency"), beginConversation: () => mutations.push("clear"),
		selectTask: () => mutations.push("select"), addUserTask: () => mutations.push("message"),
		showPreparing: () => mutations.push("preparing"), noteActivity: () => mutations.push("activity"),
		updateTask: () => mutations.push("update"), persist: () => mutations.push("persist"),
		broadcast: () => mutations.push("broadcast"), prepare: async () => mutations.push("prepare"),
	})

	await assert.rejects(flow.execute({ text: "new", images: [], files: [], requestedWorkspacePath: "", initialCwd: "C:\\repo", requestId: "r1", broadcast: true }), /stop failed/)
	assert.deepEqual(mutations, ["stop"])
})

test("failed previous-session shutdown restores its event ownership", async () => {
	const closing = []
	const flow = new PrepareNewTaskFlow({
		isRuntimeAvailable: () => true, workspaceRoots: async () => [], resolveWorkspacePath: () => null,
		updateTask: () => {}, publishPreparing: () => {}, activeSessionId: () => "old-session",
		markClosing: (sessionId, value = true) => closing.push([sessionId, value]),
		stopSession: async () => { throw new Error("stop failed") }, runHook: () => {},
		normalizeImages: async () => [], launch: async () => {}, projectError: async () => {}, log: () => {},
	})

	await assert.rejects(flow.stopPrevious(), /stop failed/)
	assert.deepEqual(closing, [["old-session", true], ["old-session", false]])
})
