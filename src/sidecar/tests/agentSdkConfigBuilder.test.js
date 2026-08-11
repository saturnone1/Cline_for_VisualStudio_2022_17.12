const assert = require("node:assert/strict")
const test = require("node:test")
const { AgentSdkConfigBuilder } = require("../dist/infrastructure/configuration/AgentSdkConfigBuilder")

test("automatic compaction and configured context size are delegated to the SDK", async () => {
	const builder = new AgentSdkConfigBuilder({
		state: () => ({
			apiConfiguration: { actModeApiProvider: "ollama", actModeOllamaModelId: "test-model", ollamaApiOptionsCtxNum: 4096 },
			mode: "act",
			preferredLanguage: "Korean - 한국어",
			useAutoCondense: true,
		}),
		resolveModelId: async () => "test-model",
		scheduledAgentsEnabled: () => false,
		log: () => undefined,
	})

	const config = await builder.build("C:\\workspace")
	assert.deepEqual(config.compaction, { enabled: true, strategy: "agentic" })
	assert.deepEqual(config.knownModels, { "test-model": { id: "test-model", contextWindow: 4096 } })
	assert.deepEqual(config.providerConfig.modelInfo, { id: "test-model", contextWindow: 4096 })
	assert.equal(config.providerConfig.providerId, "ollama")
	assert.equal(config.providerConfig.modelId, "test-model")
})

test("automatic compaction remains disabled when the setting is off", async () => {
	const builder = new AgentSdkConfigBuilder({
		state: () => ({ apiConfiguration: { apiProvider: "ollama", ollamaModelId: "test-model" }, mode: "act", useAutoCondense: false }),
		resolveModelId: async () => "test-model",
		scheduledAgentsEnabled: () => false,
		log: () => undefined,
	})

	assert.deepEqual((await builder.build("C:\\workspace")).compaction, { enabled: false })
})

test("disabled reasoning is represented by thinking false instead of an unsupported SDK effort", async () => {
	const builder = new AgentSdkConfigBuilder({
		state: () => ({
			apiConfiguration: { actModeApiProvider: "ollama", actModeOllamaModelId: "test-model", actModeReasoningEffort: "none" },
			mode: "act",
		}),
		resolveModelId: async () => "test-model",
		scheduledAgentsEnabled: () => false,
		log: () => undefined,
	})

	const config = await builder.build("C:\\workspace")
	assert.equal(config.thinking, false)
	assert.equal(config.reasoningEffort, undefined)
	assert.equal(config.providerConfig.reasoningEffort, undefined)
})

test("parallel tool calling follows explicit settings without duplicating SDK mode instructions", async () => {
	const state = {
		apiConfiguration: { apiProvider: "ollama", ollamaModelId: "test-model" },
		mode: "plan",
		enableParallelToolCalling: false,
		strictPlanModeEnabled: false,
	}
	const builder = new AgentSdkConfigBuilder({
		state: () => state,
		resolveModelId: async () => "test-model",
		scheduledAgentsEnabled: () => false,
		log: () => undefined,
	})

	const sequential = await builder.build("C:\\workspace")
	assert.equal(sequential.maxParallelToolCalls, 1)
	assert.match(sequential.systemPrompt, /until an actual tool result confirms it/)
	assert.match(sequential.systemPrompt, /Do not end a turn immediately after announcing an action/)
	assert.doesNotMatch(sequential.systemPrompt, /You are in PLAN mode/)
	assert.match(sequential.systemPrompt, /shell selected in LIG VS settings/)
	assert.doesNotMatch(sequential.systemPrompt, /Windows cmd\.exe/)

	state.enableParallelToolCalling = true
	const parallel = await builder.build("C:\\workspace")
	assert.equal(parallel.maxParallelToolCalls, undefined)
})

test("SDK execution defaults are not overridden unless an environment override is explicit", async () => {
	const previous = process.env.VSCLINE_MAX_CONSECUTIVE_MISTAKES
	delete process.env.VSCLINE_MAX_CONSECUTIVE_MISTAKES
	try {
		const builder = new AgentSdkConfigBuilder({
			state: () => ({ apiConfiguration: { apiProvider: "ollama", ollamaModelId: "test-model" }, mode: "act" }),
			resolveModelId: async () => "test-model",
			scheduledAgentsEnabled: () => false,
			log: () => undefined,
		})

		const defaults = await builder.build("C:\\workspace")
		assert.equal(defaults.execution, undefined)
		assert.equal(typeof defaults.onConsecutiveMistakeLimitReached, "function")

		process.env.VSCLINE_MAX_CONSECUTIVE_MISTAKES = "4"
		const overridden = await builder.build("C:\\workspace")
		assert.equal(overridden.execution.maxConsecutiveMistakes, 4)
		assert.equal(overridden.execution.loopDetection, undefined)
	} finally {
		if (previous === undefined) delete process.env.VSCLINE_MAX_CONSECUTIVE_MISTAKES
		else process.env.VSCLINE_MAX_CONSECUTIVE_MISTAKES = previous
	}
})

test("legacy auto approval request limits do not cap the SDK iteration budget", async () => {
	const state = {
		apiConfiguration: { apiProvider: "ollama", ollamaModelId: "test-model" },
		mode: "act",
		autoApprovalSettings: { enabled: true, maxRequests: 37 },
	}
	const builder = new AgentSdkConfigBuilder({
		state: () => state,
		resolveModelId: async () => "test-model",
		scheduledAgentsEnabled: () => false,
		log: () => undefined,
	})

	assert.equal((await builder.build("C:\\workspace")).maxIterations, undefined)
	state.autoApprovalSettings.enabled = false
	assert.equal((await builder.build("C:\\workspace")).maxIterations, undefined)
})

test("an explicit environment iteration limit is forwarded to the SDK", async () => {
	const previous = process.env.VSCLINE_MAX_ITERATIONS
	process.env.VSCLINE_MAX_ITERATIONS = "37"
	try {
		const builder = new AgentSdkConfigBuilder({
			state: () => ({
				apiConfiguration: { apiProvider: "ollama", ollamaModelId: "test-model" },
				mode: "act",
				autoApprovalSettings: { enabled: true, maxRequests: 20 },
			}),
			resolveModelId: async () => "test-model",
			scheduledAgentsEnabled: () => false,
			log: () => undefined,
		})

		assert.equal((await builder.build("C:\\workspace")).maxIterations, 37)
	} finally {
		if (previous === undefined) delete process.env.VSCLINE_MAX_ITERATIONS
		else process.env.VSCLINE_MAX_ITERATIONS = previous
	}
})

test("native Ollama endpoints use the SDK Ollama protocol and root URL", async () => {
	const builder = new AgentSdkConfigBuilder({
		state: () => ({ apiConfiguration: { actModeApiProvider: "ollama", ollamaBaseUrl: "http://localhost:11434", actModeOllamaModelId: "test-model" }, mode: "act" }),
		resolveModelId: async () => "test-model",
		scheduledAgentsEnabled: () => false,
		log: () => undefined,
	})

	const config = await builder.build("C:\\workspace")
	assert.equal(config.providerId, "ollama")
	assert.equal(config.baseUrl, "http://localhost:11434")
})

test("Ollama settings with an explicit v1 endpoint use the OpenAI-compatible protocol", async () => {
	const builder = new AgentSdkConfigBuilder({
		state: () => ({ apiConfiguration: { actModeApiProvider: "ollama", ollamaBaseUrl: "https://inference.example.test/v1/", ollamaApiKey: "test-key", actModeOllamaModelId: "test-model" }, mode: "act" }),
		resolveModelId: async () => "test-model",
		scheduledAgentsEnabled: () => false,
		log: () => undefined,
	})

	const config = await builder.build("C:\\workspace")
	assert.equal(config.providerId, "openai-compatible")
	assert.equal(config.baseUrl, "https://inference.example.test/v1")
	assert.equal(config.apiKey, "test-key")
})
