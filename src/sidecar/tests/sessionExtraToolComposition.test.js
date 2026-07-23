const assert = require("node:assert/strict")
const test = require("node:test")
const { createSessionExtraTools } = require("../dist/infrastructure/sdk/SessionExtraToolComposition")

test("MCP setup failure does not block host tools or the conversation session", async () => {
	const logs = []
	const hostTool = { name: "document_read" }
	const tools = await createSessionExtraTools({
		loadMcpTools: async () => { throw new Error("invalid MCP settings") },
		loadHostTools: () => [hostTool],
		log: (level, message, metadata) => logs.push({ level, message, metadata }),
	})

	assert.deepEqual(tools, [hostTool])
	assert.equal(logs.length, 1)
	assert.equal(logs[0].level, "warn")
	assert.match(logs[0].metadata.error, /invalid MCP settings/)
})

test("session extra tools combine available MCP and host tools", async () => {
	const mcpTool = { name: "mcp_tool" }
	const hostTool = { name: "document_read" }
	const tools = await createSessionExtraTools({
		loadMcpTools: async () => [mcpTool],
		loadHostTools: () => [hostTool],
		log: () => undefined,
	})

	assert.deepEqual(tools, [mcpTool, hostTool])
})
