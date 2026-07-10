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
