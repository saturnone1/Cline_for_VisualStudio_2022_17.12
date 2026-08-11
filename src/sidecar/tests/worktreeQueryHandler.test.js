const assert = require("node:assert/strict")
const test = require("node:test")
const { WorktreeQueryHandler } = require("../dist/features/worktrees/WorktreeQueryHandler")

function createOperations(responses = new Map()) {
	return {
		currentDirectory: "C:\\repo",
		getWorkspacePaths: async () => ["C:\\repo"],
		runGit: async (args) => responses.get(args.join(" ")) || { success: true, stdout: "", stderr: "", exitCode: 0 },
		pathExists: async () => true,
		readTextFile: async () => "node_modules",
		writeTextFile: async () => undefined,
		joinPath: (...parts) => parts.join("\\"),
		baseName: () => "repo",
		dirName: () => "C:\\",
		samePath: (left, right) => left.toLowerCase() === right.toLowerCase(),
	}
}

const logger = { log() {} }

test("worktree query handler owns porcelain projection and dirty status", async () => {
	const responses = new Map([
		["rev-parse --show-toplevel", { success: true, stdout: "C:\\repo\n", stderr: "", exitCode: 0 }],
		["worktree list --porcelain", { success: true, stdout: "worktree C:\\repo\nHEAD abc\nbranch refs/heads/main\n\nworktree C:\\feature\nHEAD def\nbranch refs/heads/feature/test\n", stderr: "", exitCode: 0 }],
		["status --porcelain", { success: true, stdout: " M src/app.ts\n?? notes.txt\n", stderr: "", exitCode: 0 }],
	])
	const handler = new WorktreeQueryHandler(createOperations(responses), logger)
	const result = await handler.listWorktrees("C:\\repo")

	assert.equal(result.worktrees.length, 2)
	assert.equal(result.worktrees[0].isCurrent, true)
	assert.equal(result.worktrees[1].branch, "feature/test")
	assert.equal(result.worktrees[1].dirty, true)
	assert.match(result.worktrees[1].statusSummary, /2 changes/)
})

test("worktree query handler reports missing Git without leaking process errors", async () => {
	const operations = createOperations(new Map([["--version", { success: false, stdout: "", stderr: "not found", exitCode: 1 }]]))
	const result = await new WorktreeQueryHandler(operations, logger).listWorktrees("C:\\repo")

	assert.equal(result.isGitRepo, false)
	assert.equal(result.errorKind, "git_missing")
	assert.deepEqual(result.worktrees, [])
})
