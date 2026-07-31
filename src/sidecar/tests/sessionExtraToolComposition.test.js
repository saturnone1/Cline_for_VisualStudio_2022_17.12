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
	const productTool = { name: "ask_user" }
	const tools = await createSessionExtraTools({
		loadMcpTools: async () => [mcpTool],
		loadHostTools: () => [hostTool],
		loadProductTools: () => [productTool],
		log: () => undefined,
	})

	assert.deepEqual(tools, [mcpTool, hostTool, productTool])
})

test("session extra tools share one failure boundary", async () => {
	const logs = []
	const tools = await createSessionExtraTools({
		loadMcpTools: async () => [],
		loadHostTools: () => [{ name: "host_tool", execute: async () => { throw { message: "host RPC unavailable" } } }],
		log: (level, message, metadata) => logs.push({ level, message, metadata }),
	})

	await assert.rejects(() => tools[0].execute({}), /Tool "host_tool" failed: host RPC unavailable/)
	assert.equal(logs.at(-1).message, "Agent tool execution failed")
})
