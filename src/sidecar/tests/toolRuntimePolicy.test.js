const assert = require("node:assert/strict")
const test = require("node:test")
const { createToolPolicies, isStrictPlanModeBlockedTool } = require("../dist/infrastructure/configuration/ProviderConfiguration")

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
