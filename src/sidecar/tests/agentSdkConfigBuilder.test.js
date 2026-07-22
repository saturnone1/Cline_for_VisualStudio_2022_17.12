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
