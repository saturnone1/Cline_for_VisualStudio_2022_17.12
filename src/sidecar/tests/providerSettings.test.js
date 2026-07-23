const assert = require("node:assert/strict")
const test = require("node:test")
const { selectProvider } = require("../dist/features/providers/ProviderSelection")
const { resolveRequestedPlanActMode } = require("../dist/features/settings/PlanActMode")
const { resolveConfiguredContextWindow } = require("../dist/infrastructure/configuration/ProviderConfiguration")
const { SdkSettingsHandler } = require("../dist/features/settings/SdkSettingsHandler")

test("provider slice selects mode-specific provider and model", () => {
	assert.deepEqual(selectProvider({ actModeApiProvider: "ollama", actModeOllamaModelId: "qwen" }, "act"), {
		modePrefix: "actMode", providerId: "ollama", modelId: "qwen",
	})
	assert.deepEqual(selectProvider({ planModeApiProvider: "openai", planModeOpenAiModelId: "gpt" }, "plan"), {
		modePrefix: "planMode", providerId: "openai", modelId: "gpt",
	})
})

test("provider slice reads every provider-specific model field used by the settings UI", () => {
	for (const [providerId, field] of [
		["cline", "actModeClineModelId"],
		["sapaicore", "actModeSapAiCoreModelId"],
		["huawei-cloud-maas", "actModeHuaweiCloudMaasModelId"],
		["nousResearch", "actModeNousResearchModelId"],
	]) {
		assert.equal(selectProvider({ actModeApiProvider: providerId, [field]: "selected-model" }, "act").modelId, "selected-model", providerId)
	}
})

test("configured context windows use provider-specific model info", () => {
	for (const [providerId, field] of [
		["cline", "actModeClineModelInfo"],
		["requesty", "actModeRequestyModelInfo"],
		["litellm", "actModeLiteLlmModelInfo"],
		["groq", "actModeGroqModelInfo"],
		["huggingface", "actModeHuggingFaceModelInfo"],
		["baseten", "actModeBasetenModelInfo"],
		["huawei-cloud-maas", "actModeHuaweiCloudMaasModelInfo"],
		["vercel-ai-gateway", "actModeVercelAiGatewayModelInfo"],
		["oca", "actModeOcaModelInfo"],
		["hicap", "actModeHicapModelInfo"],
	]) {
		assert.equal(resolveConfiguredContextWindow({ [field]: { contextWindow: 12345 } }, providerId, "actMode", "model"), 12345, providerId)
	}
})

test("settings slice normalizes explicit and toggle Plan/Act requests", () => {
	assert.equal(resolveRequestedPlanActMode({ mode: "PLAN" }, "act"), "plan")
	assert.equal(resolveRequestedPlanActMode({}, "plan"), "act")
})

test("settings entries without paths use stable identifiers", async () => {
	const settings = new SdkSettingsHandler({
		listSettings: async () => ({ rules: [{ id: "rule-id", enabled: true }, { name: "named-rule", enabled: false }] }),
	})
	const first = await settings.instructions("C:\\workspace")
	const second = await settings.instructions("C:\\workspace")
	assert.deepEqual(first, second)
	assert.deepEqual(first.localClineRulesToggles, { "rule-id": true, "named-rule": false })
})
