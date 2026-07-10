const assert = require("node:assert/strict")
const test = require("node:test")
const { McpUseCase } = require("../dist/application/useCases/McpUseCase")

test("MCP queries are delegated without changing their result", async () => {
	const runtime = {
		getMcpServersResponse: async () => ({ servers: [{ name: "mcp-vs" }] }),
		getMcpSettingsPath: async () => "C:\\settings\\mcp.json",
	}
	const useCase = new McpUseCase(runtime)

	assert.deepEqual(await useCase.listServers(), { servers: [{ name: "mcp-vs" }] })
	assert.equal(await useCase.getSettingsPath(), "C:\\settings\\mcp.json")
})

test("MCP mutations select the matching runtime operation", async () => {
	const calls = []
	const operation = (name) => async (request) => {
		calls.push([name, request])
		return { name }
	}
	const runtime = {
		addRemoteMcpServer: operation("add"),
		updateMcpTimeout: operation("timeout"),
		restartMcpServer: operation("restart"),
		deleteMcpServer: operation("delete"),
		toggleMcpToolAutoApprove: operation("approve"),
		setMcpServerDisabled: operation("toggle"),
		authenticateMcpServer: operation("authenticate"),
	}
	const useCase = new McpUseCase(runtime)
	const request = { name: "mcp-vs" }

	for (const action of [
		"addRemoteServer",
		"updateTimeout",
		"restartServer",
		"deleteServer",
		"toggleToolAutoApprove",
		"toggleServer",
		"authenticateServer",
	]) {
		await useCase.mutate(action, request)
	}

	assert.deepEqual(calls.map(([name]) => name), ["add", "timeout", "restart", "delete", "approve", "toggle", "authenticate"])
	assert.ok(calls.every(([, value]) => value === request))
})
