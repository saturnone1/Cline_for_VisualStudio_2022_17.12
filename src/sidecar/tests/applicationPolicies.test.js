const assert = require("node:assert/strict")
const test = require("node:test")
const { normalizeCommandForPlatform, serializeCommandInvocationForPlatform } = require("../dist/application/services/CommandPolicy")
const { replaceTextExactlyOnce } = require("../dist/application/services/TextEditPolicy")
const { countLineChanges, parseApplyPatchChanges } = require("../dist/application/services/PatchPolicy")

test("command policy normalizes Windows path arguments without changing URLs", () => {
	assert.equal(normalizeCommandForPlatform("type src/shared/config.ts", "win32"), "type src\\shared\\config.ts")
	assert.equal(normalizeCommandForPlatform("open https://example.com/a/b", "win32"), "open https://example.com/a/b")
	assert.equal(normalizeCommandForPlatform("type src/shared/config.ts", "linux"), "type src/shared/config.ts")
})

test("structured command arguments preserve spaces and shell metacharacters", () => {
	assert.equal(
		serializeCommandInvocationForPlatform("dotnet", ["build", "C:/Work/My Project/App.csproj"], "win32"),
		'dotnet build "C:\\Work\\My Project\\App.csproj"',
	)
	assert.equal(
		serializeCommandInvocationForPlatform("tool", ["A&B", ""], "win32"),
		'tool "A&B" ""',
	)
	assert.equal(
		serializeCommandInvocationForPlatform("tool", ["two words", "it's"], "linux"),
		`tool 'two words' 'it'"'"'s'`,
	)
})

test("editor replacement requires one unambiguous match", () => {
	assert.equal(replaceTextExactlyOnce("before target after", "target", "done", "file.ts"), "before done after")
	assert.throws(() => replaceTextExactlyOnce("none", "target", "done", "file.ts"), /not found/)
	assert.throws(() => replaceTextExactlyOnce("target target", "target", "done", "file.ts"), /more than once/)
})

test("patch policy extracts file operations and counts changed lines", () => {
	const changes = parseApplyPatchChanges("*** Update File: a.txt\n*** Move to: b.txt\n*** Add File: c.txt")
	assert.deepEqual(changes, [
		{ path: "a.txt", moveTo: "b.txt", action: "modified" },
		{ path: "c.txt", action: "created" },
	])
	assert.deepEqual(countLineChanges("a\nb", "a\nc\nd"), { additions: 2, deletions: 1 })
})
