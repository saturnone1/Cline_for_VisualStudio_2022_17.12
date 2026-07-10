const assert = require("node:assert/strict")
const test = require("node:test")
const { normalizeCommandForPlatform } = require("../dist/application/services/CommandPolicy")
const { countLineChanges, parseApplyPatchChanges } = require("../dist/application/services/PatchPolicy")

test("command policy normalizes Windows path arguments without changing URLs", () => {
	assert.equal(normalizeCommandForPlatform("type src/shared/config.ts", "win32"), "type src\\shared\\config.ts")
	assert.equal(normalizeCommandForPlatform("open https://example.com/a/b", "win32"), "open https://example.com/a/b")
	assert.equal(normalizeCommandForPlatform("type src/shared/config.ts", "linux"), "type src/shared/config.ts")
})

test("patch policy extracts file operations and counts changed lines", () => {
	const changes = parseApplyPatchChanges("*** Update File: a.txt\n*** Move to: b.txt\n*** Add File: c.txt")
	assert.deepEqual(changes, [
		{ path: "a.txt", moveTo: "b.txt", action: "modified" },
		{ path: "c.txt", action: "created" },
	])
	assert.deepEqual(countLineChanges("a\nb", "a\nc\nd"), { additions: 2, deletions: 1 })
})
