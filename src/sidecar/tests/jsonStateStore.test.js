const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const { JsonStateStore } = require("../dist/infrastructure/persistence/JsonStateStore")

test("state store preserves the existing synchronous save/load/clear contract", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vscline-state-"))
	const filePath = path.join(directory, "settings.json")
	const store = new JsonStateStore(filePath)
	try {
		assert.equal(store.load(), null)
		store.save({ mode: "act", messages: ["hello"] })
		assert.deepEqual(store.load(), { mode: "act", messages: ["hello"] })
		store.clear()
		assert.equal(store.load(), null)
	} finally {
		fs.rmSync(directory, { recursive: true, force: true })
	}
})

test("state store recovers a truncated primary file from its last valid backup", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vscline-state-recovery-"))
	const filePath = path.join(directory, "settings.json")
	const store = new JsonStateStore(filePath)
	try {
		store.save({ version: 1 })
		store.save({ version: 2 })
		fs.writeFileSync(filePath, "{", "utf8")

		assert.deepEqual(store.load(), { version: 1 })
		assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).version, 1)
		assert.equal(fs.existsSync(`${filePath}.${process.pid}.tmp`), false)
	} finally {
		fs.rmSync(directory, { recursive: true, force: true })
	}
})

test("state store separates bounded transcript data from settings metadata", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vscline-state-transcripts-"))
	const filePath = path.join(directory, "settings.json")
	const store = new JsonStateStore(filePath)
	try {
		const snapshot = { mode: "act", currentTaskItem: { id: "task-1" }, clineMessages: [{ type: "say", say: "text", text: "hello" }], taskSnapshots: { "task-1": { taskItem: { id: "task-1" }, messages: [] } } }
		store.save(snapshot)
		assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).mode, "act")
		assert.equal(fs.existsSync(path.join(directory, "transcripts.json")), true)
		assert.deepEqual(store.load(), snapshot)
	} finally {
		fs.rmSync(directory, { recursive: true, force: true })
	}
})

test("state store preserves cumulative context compaction data across reloads", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vscline-state-compaction-"))
	const filePath = path.join(directory, "settings.json")
	const store = new JsonStateStore(filePath)
	try {
		const compaction = {
			type: "say",
			say: "info",
			text: "Context compacted.",
			contextCompaction: { sourceSessionId: "old", sessionId: "new", summary: "durable cumulative summary" },
		}
		const snapshot = { currentTaskItem: { id: "new" }, clineMessages: [compaction] }
		store.save(snapshot)
		assert.equal(store.load().clineMessages[0].contextCompaction.summary, "durable cumulative summary")
	} finally {
		fs.rmSync(directory, { recursive: true, force: true })
	}
})

test("state store retains the latest compaction anchor when a long transcript is bounded", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vscline-state-long-compaction-"))
	const filePath = path.join(directory, "settings.json")
	const store = new JsonStateStore(filePath)
	try {
		const messages = Array.from({ length: 700 }, (_, index) => ({ ts: index + 1, type: "say", say: "text", text: `message-${index}` }))
		messages[50] = { ...messages[50], say: "info", contextCompaction: { sourceSessionId: "old", sessionId: "new", summary: "durable anchor" } }
		store.save({ currentTaskItem: { id: "new" }, clineMessages: messages })
		const loaded = store.load().clineMessages
		assert.equal(loaded.length, 600)
		assert.equal(loaded.find((message) => message.contextCompaction)?.contextCompaction.summary, "durable anchor")
	} finally {
		fs.rmSync(directory, { recursive: true, force: true })
	}
})

test("state store never merges settings and transcripts from different generations", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vscline-state-generation-"))
	const filePath = path.join(directory, "settings.json")
	const transcriptPath = path.join(directory, "transcripts.json")
	const store = new JsonStateStore(filePath)
	try {
		store.save({ mode: "act", currentTaskItem: { id: "one" }, clineMessages: [{ text: "one" }] })
		store.save({ mode: "plan", currentTaskItem: { id: "two" }, clineMessages: [{ text: "two" }] })
		const staleTranscript = JSON.parse(fs.readFileSync(`${transcriptPath}.bak`, "utf8"))
		fs.writeFileSync(transcriptPath, JSON.stringify(staleTranscript), "utf8")
		const recovered = store.load()
		assert.equal(recovered.mode, "act")
		assert.equal(recovered.currentTaskItem.id, "one")
	} finally {
		fs.rmSync(directory, { recursive: true, force: true })
	}
})

test("deferred state save writes the latest snapshot without blocking the caller", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vscline-state-deferred-"))
	const filePath = path.join(directory, "settings.json")
	const store = new JsonStateStore(filePath)
	try {
		await Promise.all([store.saveDeferred({ mode: "act" }), store.saveDeferred({ mode: "plan" })])
		assert.equal(store.load().mode, "plan")
	} finally {
		fs.rmSync(directory, { recursive: true, force: true })
	}
})
