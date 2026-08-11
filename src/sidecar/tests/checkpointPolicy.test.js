const assert = require("node:assert/strict")
const test = require("node:test")
const { createCheckpointDiffDescription, resolveCheckpointRestoreScope } = require("../dist/features/checkpoints/CheckpointPolicy")
const { CheckpointHandler } = require("../dist/features/checkpoints/CheckpointHandler")

test("checkpoint policy normalizes restore scope and stable diff metadata", () => {
	assert.deepEqual(resolveCheckpointRestoreScope("workspace"), { scope: "workspace", restore: { messages: false, workspace: true } })
	assert.deepEqual(resolveCheckpointRestoreScope("invalid").restore, { messages: true, workspace: true })
	const result = createCheckpointDiffDescription({ checkpointRunCount: 3, sessionId: "s1", workspaceRoot: "C:\\repo", diffs: [{ filePath: "Program.cs" }], trackedChanges: [] })
	assert.equal(result.success, true)
	assert.match(result.text, /checkpoint #3/i)
	assert.match(result.text, /Program\.cs/)
})

test("checkpoint compare delegates to the SDK and returns real changed files", async () => {
	const calls = []
	const handler = new CheckpointHandler({
		compareCheckpoint: async (request) => {
			calls.push(request)
			return { cwd: "C:\\repo", diffs: [{ filePath: "Program.cs", leftContent: "old", rightContent: "new" }] }
		},
	})
	const result = await handler.compare(
		{ checkpointRunCount: 3 },
		{ taskItem: { id: "s1", cwdOnTaskInitialization: "C:\\repo" }, messages: [], trackedChanges: [] },
	)

	assert.deepEqual(calls, [{ sessionId: "s1", checkpointRunCount: 3, cwd: "C:\\repo" }])
	assert.equal(result.diffs.length, 1)
	assert.match(result.text, /Program\.cs/)
})
