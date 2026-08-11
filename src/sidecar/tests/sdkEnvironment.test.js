const assert = require("node:assert/strict")
const os = require("node:os")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const { resolveUsableWorkingDirectory, resolveWorkspacePath, sanitizePathPart } = require("../dist/infrastructure/sdk/SdkEnvironment")

test("SDK workspace path resolution confines relative and absolute paths to workspace roots", (context) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ligvs-sdk-workspace-"))
	context.after(() => fs.rmSync(root, { recursive: true, force: true }))
	assert.equal(resolveWorkspacePath("src/file.ts", [root]), path.join(fs.realpathSync.native(root), "src", "file.ts"))
	assert.equal(resolveWorkspacePath(path.join(root, "docs", "readme.md"), [root]), path.join(fs.realpathSync.native(root), "docs", "readme.md"))
	assert.throws(() => resolveWorkspacePath(path.resolve(root, "..", "outside.txt"), [root]), /outside Visual Studio workspace/)
	assert.equal(
		resolveWorkspacePath(path.resolve(root, "..", "outside.txt"), [root], undefined, true),
		path.resolve(root, "..", "outside.txt"),
	)
})

test("SDK workspace path resolution rejects links and junctions that escape the workspace", (context) => {
	const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ligvs-sdk-link-"))
	const root = path.join(sandbox, "workspace")
	const outside = path.join(sandbox, "outside")
	fs.mkdirSync(root)
	fs.mkdirSync(outside)
	fs.writeFileSync(path.join(outside, "secret.txt"), "outside")
	const link = path.join(root, "external")
	fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir")
	context.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))

	assert.throws(() => resolveWorkspacePath(path.join(link, "secret.txt"), [root]), /outside Visual Studio workspace/)
	assert.throws(() => resolveWorkspacePath(path.join(link, "new.txt"), [root]), /outside Visual Studio workspace/)
})

test("SDK artifact path segments are stable and filesystem-safe", () => {
	assert.equal(sanitizePathPart("session:one/two?"), "session_one_two_")
	assert.equal(sanitizePathPart(""), "item")
	assert.equal(sanitizePathPart("a".repeat(100)).length, 80)
})

test("runtime working directory prefers a usable host path over the sidecar process directory", (context) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ligvs-working-directory-"))
	context.after(() => fs.rmSync(root, { recursive: true, force: true }))
	assert.equal(resolveUsableWorkingDirectory(["", path.join(root, "missing"), root]), root)
})
