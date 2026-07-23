const assert = require("node:assert/strict")
const test = require("node:test")
const { buildSdkStartInput, normalizeAgentMode } = require("../dist/infrastructure/sdk/SdkSessionRequestBuilder")

test("SDK start request builder translates product configuration at one boundary", () => {
	const extraTools = [{ name: "mcp_tool", __ligVsAutoApprove: true }]
	const { requestedSessionId, startInput } = buildSdkStartInput({
		prompt: "inspect",
		cwd: "",
		sessionId: "outer-session",
		providerId: "outer-provider",
		modelId: "outer-model",
		apiKey: "outer-key",
		mode: "plan",
		interactive: false,
		userImages: ["", "image.png"],
		userFiles: ["file.ts"],
		initialMessages: [{ role: "user", content: "previous" }, { role: "system", content: "ignored" }, { role: "assistant", content: "" }],
		config: { sessionId: "config-session", providerId: "config-provider", modelId: "config-model", apiKey: "config-key", enableSpawnAgent: true },
	}, ["C:\\workspace"], extraTools)

	assert.equal(requestedSessionId, "config-session")
	assert.equal(startInput.config.providerId, "config-provider")
	assert.equal(startInput.config.modelId, "config-model")
	assert.equal(startInput.config.apiKey, "config-key")
	assert.equal(startInput.config.cwd, "C:\\workspace")
	assert.equal(startInput.config.mode, "plan")
	assert.equal(startInput.config.enableSpawnAgent, true)
	assert.deepEqual(startInput.config.extraTools, [{ name: "mcp_tool" }])
	assert.deepEqual(startInput.toolPolicies.mcp_tool, { enabled: true, autoApprove: true })
	assert.equal(startInput.interactive, false)
	assert.deepEqual(startInput.userImages, ["image.png"])
	assert.deepEqual(startInput.initialMessages, [{ role: "user", content: "previous" }])
})

test("SDK mode normalization rejects adapter-unknown values", () => {
	assert.equal(normalizeAgentMode("act"), "act")
	assert.equal(normalizeAgentMode("plan"), "plan")
	assert.equal(normalizeAgentMode("debug"), undefined)
})
