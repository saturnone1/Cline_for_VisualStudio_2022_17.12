const assert = require("node:assert/strict")
const test = require("node:test")
const { VisualStudioWorkspaceClient } = require("../dist/infrastructure/host/VisualStudioHostProvider")

test("empty workspace results are retried instead of being cached", async () => {
	VisualStudioWorkspaceClient.clearWorkspacePathCache()
	let calls = 0
	const client = new VisualStudioWorkspaceClient({
		getWorkspacePaths: async () => {
			calls += 1
			return calls === 1 ? [] : ["C:\\workspace"]
		},
	})

	assert.deepEqual(await client.getWorkspacePaths({}), [])
	assert.deepEqual(await client.getWorkspacePaths({}), ["C:\\workspace"])
	assert.equal(calls, 2)
	VisualStudioWorkspaceClient.clearWorkspacePathCache()
})
