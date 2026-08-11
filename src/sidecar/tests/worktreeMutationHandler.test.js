const assert = require("node:assert/strict")
const test = require("node:test")
const { WorktreeMutationHandler } = require("../dist/features/worktrees/WorktreeMutationHandler")

function fixture(overrides = {}) {
	const calls = []
	const operations = {
		currentDirectory: "C:\\repo",
		getWorkspacePaths: async () => ["C:\\repo"],
		runGit: async (args) => { calls.push(args); return { success: true, stdout: "", stderr: "", exitCode: 0 } },
		pathExists: async () => false,
		readTextFile: async () => "",
		writeTextFile: async () => undefined,
		joinPath: (...parts) => parts.join("\\"),
		baseName: () => "repo",
		dirName: () => "C:\\",
		samePath: (left, right) => left === right,
		resolvePath: (...parts) => parts.join("\\"),
		isAbsolutePath: (value) => /^[A-Z]:\\/.test(value),
		isPathInside: () => false,
		copyPath: async () => undefined,
		findSolutions: () => [],
		openFolder: async () => ({ success: true }),
		openSolution: async () => ({ success: true }),
		...overrides,
	}
	const queries = {
		resolveGitRoot: async () => ({ workspaceRoot: "C:\\repo", gitRoot: "C:\\repo", error: "", errorKind: "" }),
		getDefaults: async () => ({ baseBranch: "main" }),
		listWorktrees: async () => ({ worktrees: [], items: [], isGitRepo: true, error: "" }),
		getStatus: async () => ({ dirty: false, statusSummary: "clean", statusEntries: [], conflictCount: 0 }),
	}
	return { handler: new WorktreeMutationHandler(operations, queries, { log() {} }), calls, queries }
}

test("worktree mutation handler rejects invalid branches before Git execution", async () => {
	const { handler, calls } = fixture()
	const result = await handler.create({ path: "C:\\feature", branch: "../invalid" }, "C:\\repo")
	assert.equal(result.success, false)
	assert.match(result.message, /Invalid branch name/)
	assert.equal(calls.length, 0)
})

test("worktree mutation handler preserves dirty-delete approval policy", async () => {
	const { handler, calls, queries } = fixture()
	queries.getStatus = async () => ({ dirty: true, statusSummary: "1 change", statusEntries: [], conflictCount: 0 })
	const result = await handler.delete({ path: "C:\\feature" }, "C:\\repo")
	assert.equal(result.success, false)
	assert.equal(result.dirty, true)
	assert.equal(calls.length, 0)
})

test("worktree mutation handler owns merge recovery commands", async () => {
	const { handler, calls } = fixture()
	const result = await handler.recover({ action: "abort", targetWorktreePath: "C:\\repo" })
	assert.equal(result.success, true)
	assert.deepEqual(calls[0], ["merge", "--abort"])
	assert.equal(result.message, "Merge aborted.")
})
