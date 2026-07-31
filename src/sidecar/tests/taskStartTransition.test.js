const assert = require("node:assert/strict")
const test = require("node:test")
const { StartNewTaskFlow } = require("../dist/features/chat/startTask/StartNewTaskFlow")
const { PrepareNewTaskFlow } = require("../dist/features/chat/startTask/PrepareNewTaskFlow")

test("a new task is projected immediately while previous-session shutdown completes", async () => {
	const mutations = []
	let releaseStop
	const stopped = new Promise((resolve) => { releaseStop = resolve })
	const flow = new StartNewTaskFlow({
		isRuntimeAvailable: () => true,
		stopPrevious: async () => { mutations.push("stop"); await stopped; mutations.push("stopped") },
		transitionStarting: () => mutations.push("starting"),
		createTask: () => { mutations.push("create"); return { id: "new-task" } },
		startLatency: () => mutations.push("latency"), beginConversation: () => mutations.push("clear"),
		selectTask: () => mutations.push("select"), addUserTask: () => mutations.push("message"),
		showPreparing: () => mutations.push("preparing"), noteActivity: () => mutations.push("activity"),
		updateTask: () => mutations.push("update"), persist: () => mutations.push("persist"),
		broadcast: () => mutations.push("broadcast"), prepare: async () => mutations.push("prepare"), fail: async () => mutations.push("fail"),
	})

	const execution = flow.execute({ text: "new", images: [], files: [], requestedWorkspacePath: "", initialCwd: "C:\\repo", requestId: "r1", broadcast: true })
	await Promise.resolve()
	assert.deepEqual(mutations, ["stop", "starting", "create", "latency", "clear", "select", "message", "preparing", "activity", "update", "persist", "broadcast"])
	releaseStop()
	await execution
	assert.deepEqual(mutations.slice(-2), ["stopped", "prepare"])
})

test("failed previous-session shutdown keeps the stale session quarantined", async () => {
	const closing = []
	const flow = new PrepareNewTaskFlow({
		isRuntimeAvailable: () => true, workspaceRoots: async () => [], resolveWorkspacePath: () => null,
		updateTask: () => {}, publishPreparing: () => {}, activeSessionId: () => "old-session",
		markClosing: (sessionId, value = true) => closing.push([sessionId, value]),
		stopSession: async () => { throw new Error("stop failed") }, runHook: () => {},
		normalizeImages: async () => [], launch: async () => {}, projectError: async () => {}, log: () => {},
	})

	await assert.rejects(flow.stopPrevious(), /stop failed/)
	assert.deepEqual(closing, [["old-session", true]])
})

test("a new task reports an unreadable image instead of silently dropping it", async () => {
	const errors = []
	let launches = 0
	const flow = new PrepareNewTaskFlow({
		isRuntimeAvailable: () => true, workspaceRoots: async () => [], resolveWorkspacePath: () => null,
		updateTask: () => {}, publishPreparing: () => {}, activeSessionId: () => "",
		markClosing: () => {}, stopSession: async () => {}, runHook: () => {},
		normalizeImages: async () => [], launch: async () => { launches++ },
		projectError: async (error) => { errors.push(error.message) }, log: () => {},
	})

	await flow.execute({ text: "review", images: ["missing.png"], files: [], requestedWorkspacePath: "", initialCwd: "C:\\repo", taskItem: { id: "task-1" } })
	assert.equal(launches, 0)
	assert.match(errors[0], /could not be read/)
})
