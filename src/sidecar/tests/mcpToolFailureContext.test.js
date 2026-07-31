const assert = require("node:assert/strict")
const test = require("node:test")
const { wrapMcpToolFailureContext } = require("../dist/infrastructure/sdk/McpToolFailureBoundary")

test("MCP execution failures retain server, tool, and transport context for the model", async () => {
	let projectedError = ""
	const tool = wrapMcpToolFailureContext({
		name: "mcp-vs__document_read",
		execute: async () => { throw new Error("HTTP 404: endpoint not found") },
	}, "mcp-vs", "document_read", (message) => { projectedError = message })

	await assert.rejects(
		() => tool.execute({ path: "Program.cs" }),
		/Tool "MCP mcp-vs\.document_read" failed: HTTP 404/,
	)
	assert.match(projectedError, /endpoint not found/)
})

test("a successful MCP retry clears transient server failure state", async () => {
	let shouldFail = true
	let projectedError = ""
	const tool = wrapMcpToolFailureContext({
		execute: async () => {
			if (shouldFail) throw new Error("temporarily unavailable")
			return "ok"
		},
	}, "mcp-vs", "document_read", (message) => { projectedError = message }, () => { projectedError = "" })

	await assert.rejects(() => tool.execute(), /temporarily unavailable/)
	assert.match(projectedError, /temporarily unavailable/)
	shouldFail = false
	assert.equal(await tool.execute(), "ok")
	assert.equal(projectedError, "")
})
