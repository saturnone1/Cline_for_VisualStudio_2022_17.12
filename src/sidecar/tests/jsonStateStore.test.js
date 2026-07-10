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
		assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), { version: 1 })
		assert.equal(fs.existsSync(`${filePath}.${process.pid}.tmp`), false)
	} finally {
		fs.rmSync(directory, { recursive: true, force: true })
	}
})
