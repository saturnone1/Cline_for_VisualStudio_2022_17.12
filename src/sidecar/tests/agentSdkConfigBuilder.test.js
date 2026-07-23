const assert = require("node:assert/strict")
const test = require("node:test")
const { AgentSdkConfigBuilder } = require("../dist/infrastructure/configuration/AgentSdkConfigBuilder")

test("LIG VS owns automatic compaction instead of enabling the SDK loop", async () => {
	const builder = new AgentSdkConfigBuilder({
		state: () => ({
			apiConfiguration: { apiProvider: "ollama", ollamaModelId: "test-model", modelContextWindow: 4096 },
			mode: "act",
			preferredLanguage: "Korean - 한국어",
			useAutoCondense: true,
		}),
		resolveModelId: async () => "test-model",
		scheduledAgentsEnabled: () => false,
		log: () => undefined,
	})

	const config = await builder.build("C:\\workspace")
	assert.deepEqual(config.compaction, { enabled: false })
})

test("parallel tool calling and Plan instructions follow explicit settings", async () => {
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
	assert.match(sequential.systemPrompt, /tools allowed by the current settings/)
	assert.match(sequential.systemPrompt, /until an actual tool result confirms it/)
	assert.match(sequential.systemPrompt, /Do not end a turn immediately after announcing an action/)
	assert.doesNotMatch(sequential.systemPrompt, /Do not modify files, run terminal commands/)

	state.enableParallelToolCalling = true
	const parallel = await builder.build("C:\\workspace")
	assert.equal(parallel.maxParallelToolCalls, undefined)
})
