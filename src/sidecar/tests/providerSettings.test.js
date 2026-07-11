const assert = require("node:assert/strict")
const test = require("node:test")
const { selectProvider } = require("../dist/features/providers/ProviderSelection")
const { resolveRequestedPlanActMode } = require("../dist/features/settings/PlanActMode")

test("provider slice selects mode-specific provider and model", () => {
	assert.deepEqual(selectProvider({ actModeApiProvider: "ollama", actModeOllamaModelId: "qwen" }, "act"), {
		modePrefix: "actMode", providerId: "ollama", modelId: "qwen",
	})
	assert.deepEqual(selectProvider({ planModeApiProvider: "openai", planModeOpenAiModelId: "gpt" }, "plan"), {
		modePrefix: "planMode", providerId: "openai", modelId: "gpt",
	})
})

test("settings slice normalizes explicit and toggle Plan/Act requests", () => {
	assert.equal(resolveRequestedPlanActMode({ mode: "PLAN" }, "act"), "plan")
	assert.equal(resolveRequestedPlanActMode({}, "plan"), "act")
})
