const assert = require("node:assert/strict")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const { resolveWorkspacePath, sanitizePathPart } = require("../dist/infrastructure/sdk/SdkEnvironment")

test("SDK workspace path resolution confines relative and absolute paths to workspace roots", () => {
	const root = path.join(os.tmpdir(), "ligvs-sdk-workspace")
	assert.equal(resolveWorkspacePath("src/file.ts", [root]), path.join(root, "src", "file.ts"))
	assert.equal(resolveWorkspacePath(path.join(root, "docs", "readme.md"), [root]), path.join(root, "docs", "readme.md"))
	assert.throws(() => resolveWorkspacePath(path.resolve(root, "..", "outside.txt"), [root]), /outside Visual Studio workspace/)
})

test("SDK artifact path segments are stable and filesystem-safe", () => {
	assert.equal(sanitizePathPart("session:one/two?"), "session_one_two_")
	assert.equal(sanitizePathPart(""), "item")
	assert.equal(sanitizePathPart("a".repeat(100)).length, 80)
})
