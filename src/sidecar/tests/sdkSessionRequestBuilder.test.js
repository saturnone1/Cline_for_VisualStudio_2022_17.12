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

test("SDK start request builder omits an empty prompt instead of starting a blank turn", () => {
	const { startInput } = buildSdkStartInput({ prompt: "", cwd: "C:\\workspace", interactive: true }, [], [])
	assert.equal("prompt" in startInput, false)
})

test("SDK fallback prompt requires tool evidence before reporting success", () => {
	const { startInput } = buildSdkStartInput({ prompt: "fetch documentation", cwd: "C:\\workspace" }, [], [])
	assert.match(startInput.config.systemPrompt, /until an actual tool result confirms it/)
	assert.match(startInput.config.systemPrompt, /instead of inventing a result/)
	assert.match(startInput.config.systemPrompt, /never generalize results from tested operations to untested capabilities/)
})

test("SDK resumed context is explicitly historical instead of replayed messages", () => {
	const { startInput } = buildSdkStartInput({
		prompt: "다시 실행해",
		cwd: "C:\\workspace",
		sessionMetadata: { ligVsResumed: true, ligVsResumedContext: "[Previous user]\n이전 요청" },
	}, [], [])

	assert.equal(startInput.initialMessages, undefined)
	assert.match(startInput.config.systemPrompt, /historical context from a previous session/)
	assert.match(startInput.config.systemPrompt, /not evidence that the current user request has been executed/)
	assert.match(startInput.config.systemPrompt, /\[Previous user\]\n이전 요청/)
})

test("SDK request builder replaces a builtin tool at the SDK routing boundary", () => {
	const questionTool = {
		name: "ask_question",
		__ligVsReplacesBuiltinTool: "ask_question",
		execute: async () => "selected",
	}
	const { startInput } = buildSdkStartInput(
		{
			prompt: "choose",
			cwd: "C:\\workspace",
			toolPolicies: { ask_question: { enabled: true, autoApprove: false } },
		},
		[],
		[questionTool],
	)

	assert.equal(startInput.config.extraTools[0].__ligVsReplacesBuiltinTool, undefined)
	assert.deepEqual(startInput.config.toolRoutingRules, [{
		name: "lig-vs-product-tool-replacements",
		mode: "any",
		disableTools: ["ask_question"],
	}])
	assert.deepEqual(startInput.toolPolicies.ask_question, { enabled: true, autoApprove: true })
})

test("SDK request builder carries a disabled builtin question policy to its product replacement", () => {
	const { startInput } = buildSdkStartInput(
		{ prompt: "choose", toolPolicies: { ask_question: { enabled: false, autoApprove: true } } },
		[],
		[{ name: "ask_question", __ligVsReplacesBuiltinTool: "ask_question" }],
	)

	assert.equal(startInput.toolPolicies.ask_question.enabled, false)
})

test("SDK request builder carries wildcard restrictions to a product replacement", () => {
	const { startInput } = buildSdkStartInput(
		{ prompt: "choose", toolPolicies: { "*": { enabled: false, autoApprove: false } } },
		[],
		[{ name: "ask_question", __ligVsReplacesBuiltinTool: "ask_question" }],
	)

	assert.deepEqual(startInput.toolPolicies.ask_question, { enabled: false, autoApprove: true })
})

test("SDK request builder preserves configured routing rules when replacing a builtin", () => {
	const { startInput } = buildSdkStartInput(
		{ config: { toolRoutingRules: [{ name: "existing", mode: "plan", disableTools: ["bash"] }] } },
		[],
		[{ name: "ask_question", __ligVsReplacesBuiltinTool: "ask_question" }],
	)

	assert.equal(startInput.config.toolRoutingRules.length, 2)
	assert.equal(startInput.config.toolRoutingRules[0].name, "existing")
	assert.deepEqual(startInput.config.toolRoutingRules[1].disableTools, ["ask_question"])
})
