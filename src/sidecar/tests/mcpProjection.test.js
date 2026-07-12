const assert = require("node:assert/strict")
const test = require("node:test")
const {
	callMcpListMethod,
	isToolAutoApproved,
	normalizeMcpPrompts,
	normalizeMcpResources,
	normalizeMcpResourceTemplates,
	toDisplayMcpConfig,
	toProtoMcpStatus,
} = require("../dist/infrastructure/sdk/McpProjection")

test("MCP projection drops malformed discovery entries and preserves useful metadata", () => {
	assert.deepEqual(normalizeMcpResources([{ uri: "file://one", name: "One" }, { name: "missing" }]), [{ uri: "file://one", name: "One", mimeType: undefined, description: undefined }])
	assert.deepEqual(normalizeMcpResourceTemplates([{ uriTemplate: "file://{path}" }]), [{ uriTemplate: "file://{path}", name: "file://{path}", description: undefined, mimeType: undefined }])
	assert.deepEqual(normalizeMcpPrompts([{ name: "review", arguments: [{ name: "path", required: true }, { description: "missing" }] }]), [{ name: "review", title: undefined, description: undefined, arguments: [{ name: "path", description: undefined, required: true }] }])
})

test("MCP projection owns approval, status, and display configuration", () => {
	assert.equal(isToolAutoApproved({ metadata: { autoApproveTools: ["read_file"] } }, "read_file"), true)
	assert.equal(toProtoMcpStatus("connected"), "MCP_SERVER_STATUS_CONNECTED")
	assert.equal(toProtoMcpStatus("failed"), "MCP_SERVER_STATUS_DISCONNECTED")
	assert.deepEqual(toDisplayMcpConfig({}, { transport: { type: "sse", url: "https://mcp.test" }, timeout: 30, disabled: true }), { type: "sse", url: "https://mcp.test", timeout: 30, disabled: true })
})

test("MCP list compatibility tries available SDK method names and contains failures", async () => {
	const manager = { listResources: undefined, getResources: async (serverName) => [{ uri: `file://${serverName}` }] }
	assert.deepEqual(await callMcpListMethod(manager, "server", ["listResources", "getResources"]), [{ uri: "file://server" }])
	assert.equal(await callMcpListMethod({ listResources: async () => { throw new Error("offline") } }, "server", ["listResources"]), undefined)
})
