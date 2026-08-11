const assert = require("node:assert/strict")
const test = require("node:test")
const { createToolPolicies, isStrictPlanModeBlockedTool } = require("../dist/infrastructure/configuration/ProviderConfiguration")
const { mapToolName, shouldAutoApproveTool } = require("../dist/infrastructure/conversation/ToolCommandFormatting")

test("all SDK default tools remain enabled unless an explicit setting disables them", async () => {
	const sdk = await import("@cline/sdk")
	const policies = createToolPolicies({}, { disableToolUse: false }, "act")
	for (const toolName of sdk.ALL_DEFAULT_TOOL_NAMES) {
		assert.equal(policies[toolName]?.enabled, true, `${toolName} must be enabled`)
	}
	assert.equal(policies.browser_action.enabled, true)
	assert.equal(policies.use_mcp_server.enabled, true)

	const disabled = createToolPolicies({}, { disableToolUse: true }, "act")
	assert.equal(disabled.fetch_web_content.enabled, false)
	assert.equal(disabled.browser_action.enabled, false)
	assert.equal(disabled.read_files.enabled, true)
	assert.equal(disabled.run_commands.enabled, true)
})

test("Plan mode does not restrict tools unless Strict Plan Mode is enabled", () => {
	const planPolicies = createToolPolicies({}, { disableToolUse: false }, "plan", false)
	assert.equal(planPolicies.run_commands.enabled, true)
	assert.equal(planPolicies.fetch_web_content.enabled, true)
	assert.equal(planPolicies.browser_action.enabled, true)
	assert.equal(planPolicies.use_mcp_server.enabled, true)
	assert.equal(planPolicies.editor.enabled, true)

	const strictPolicies = createToolPolicies({}, { disableToolUse: false }, "plan", true)
	assert.equal(strictPolicies.editor.enabled, false)
	assert.equal(strictPolicies.apply_patch.enabled, false)
	assert.equal(strictPolicies.run_commands.enabled, true)
	assert.equal(strictPolicies.fetch_web_content.enabled, true)
	assert.equal(strictPolicies.browser_action.enabled, true)
	assert.equal(strictPolicies.use_mcp_server.enabled, true)
	assert.equal(isStrictPlanModeBlockedTool("editor"), true)
	assert.equal(isStrictPlanModeBlockedTool("run_commands"), false)
})

test("browser auto approval also applies to web fetch", () => {
	const enabled = { enabled: true, actions: { useBrowser: true } }
	const policies = createToolPolicies(enabled, { disableToolUse: false }, "act")
	assert.equal(policies.fetch_web_content.autoApprove, true)

	const notApproved = createToolPolicies({ enabled: true, actions: { useBrowser: false } }, { disableToolUse: false }, "act")
	assert.equal(notApproved.fetch_web_content.autoApprove, false)
})

test("Yolo mode approves tools and removes the question tool", () => {
	const policies = createToolPolicies({}, { disableToolUse: false }, "act", false, true)
	assert.equal(policies["*"].autoApprove, true)
	assert.equal(policies.fetch_web_content.autoApprove, true)
	assert.equal(policies.ask_question.enabled, false)
	assert.equal(shouldAutoApproveTool("run_commands", {}, true), true)
	assert.equal(shouldAutoApproveTool("ask_question", {}, true), false)
})

test("generated MCP tool names share the MCP approval category", () => {
	assert.equal(mapToolName("mcp-vs2022__document_read"), "useMcpServer")
	assert.equal(shouldAutoApproveTool("mcp-vs2022__document_read", { enabled: true, actions: { useMcp: true } }), true)
})
