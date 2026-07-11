const assert = require("node:assert/strict")
const test = require("node:test")
const { createCheckpointDiffDescription, resolveCheckpointRestoreScope } = require("../dist/features/checkpoints/CheckpointPolicy")

test("checkpoint policy normalizes restore scope and stable diff metadata", () => {
	assert.deepEqual(resolveCheckpointRestoreScope("workspace"), { scope: "workspace", restore: { messages: false, workspace: true } })
	assert.deepEqual(resolveCheckpointRestoreScope("invalid").restore, { messages: true, workspace: true })
	const result = createCheckpointDiffDescription({ checkpointRunCount: 3, sessionId: "s1", workspaceRoot: "C:\\repo", trackedChanges: [] })
	assert.equal(result.success, true)
	assert.match(result.text, /checkpoint #3/i)
})
