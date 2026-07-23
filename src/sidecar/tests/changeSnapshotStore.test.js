const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const { pruneChangeSnapshots, writeChangeSnapshot } = require("../dist/infrastructure/sdk/ChangeSnapshotStore")

test("parallel snapshots for the same file never overwrite one another", async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "vscline-snapshot-write-"))
	const previousLocalAppData = process.env.LOCALAPPDATA
	process.env.LOCALAPPDATA = root
	t.after(() => {
		if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA
		else process.env.LOCALAPPDATA = previousLocalAppData
		fs.rmSync(root, { recursive: true, force: true })
	})

	const [first, second] = await Promise.all([
		writeChangeSnapshot("C:/repo/file.cs", "first", "session"),
		writeChangeSnapshot("C:/repo/file.cs", "second", "session"),
	])
	assert.notEqual(first, second)
	assert.equal(fs.readFileSync(first, "utf8"), "first")
	assert.equal(fs.readFileSync(second, "utf8"), "second")
})

test("change snapshot retention removes expired and over-budget files", async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "vscline-snapshots-"))
	t.after(() => fs.rmSync(root, { recursive: true, force: true }))
	const session = path.join(root, "session")
	fs.mkdirSync(session)
	const old = path.join(session, "old.before")
	const newest = path.join(session, "newest.before")
	const overflow = path.join(session, "overflow.before")
	fs.writeFileSync(old, "old")
	fs.writeFileSync(overflow, "overflow")
	fs.writeFileSync(newest, "newest")
	fs.utimesSync(old, new Date(1_000), new Date(1_000))
	fs.utimesSync(overflow, new Date(9_000), new Date(9_000))
	fs.utimesSync(newest, new Date(10_000), new Date(10_000))

	await pruneChangeSnapshots(root, { maximumAgeMs: 5_000, maximumFiles: 1, maximumBytes: 1024 }, 10_000)
	assert.equal(fs.existsSync(old), false)
	assert.equal(fs.existsSync(overflow), false)
	assert.equal(fs.existsSync(newest), true)
})
