const assert = require("node:assert/strict")
const test = require("node:test")
const { SettingsRpcHandler } = require("../dist/features/settings/SettingsRpcHandler")

function fixture() {
	const state = {}
	const calls = []
	const handler = new SettingsRpcHandler({
		state: () => state,
		applySettings: (settings) => Object.assign(state, settings),
		persist: () => calls.push("persist"),
		broadcast: async () => { calls.push("broadcast") },
		clearPersistedState: () => calls.push("clear"),
		resetState: () => calls.push("reset"),
		clearTask: async () => { calls.push("clearTask") },
	})
	return { state, calls, handler }
}

test("dedicated settings mutations persist before broadcasting", async () => {
	for (const command of [
		{ type: "setTelemetry", value: "enabled" },
		{ type: "dismissBanner", banner: "model", version: 7 },
		{ type: "setBannerVersion", banner: "info", version: 8 },
		{ type: "setTerminalTimeout", timeout: 4500 },
		{ type: "completeWelcome" },
		{ type: "toggleFavorite", modelId: "model-1" },
	]) {
		const { calls, handler } = fixture()
		await handler.handle(command)
		assert.deepEqual(calls, ["persist", "broadcast"], command.type)
	}
})

test("settings apply persists synchronously and requests a fresh state projection", async () => {
	const { state, calls, handler } = fixture()
	const result = await handler.handle({ type: "apply", settings: { useAutoCondense: true } })

	assert.equal(state.useAutoCondense, true)
	assert.deepEqual(calls, ["persist"])
	assert.equal(result.includeStateMessages, true)
})
