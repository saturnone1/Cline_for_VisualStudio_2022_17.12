const assert = require("node:assert/strict")
const test = require("node:test")
const { SettingsMutationHandler } = require("../dist/infrastructure/configuration/SettingsMutationHandler")

function createHandler(state) {
	const calls = []
	const handler = new SettingsMutationHandler({
		state: () => state,
		profiles: { syncActive() {}, ensure() {}, activate() {} },
		refreshWebTools: () => calls.push("refreshWebTools"),
		runtimeChanged: () => calls.push("runtimeChanged"),
	})
	return { handler, calls }
}

test("web tools feature toggle updates the browser runtime setting", () => {
	const state = { browserSettings: { disableToolUse: false } }
	const { handler, calls } = createHandler(state)
	handler.apply({ clineWebToolsEnabled: false })
	assert.equal(state.browserSettings.disableToolUse, true)
	assert.deepEqual(calls, ["refreshWebTools", "runtimeChanged"])
})

test("enabling Yolo mode switches the runtime to Act mode", () => {
	const state = { mode: "plan", yoloModeToggled: false }
	const { handler, calls } = createHandler(state)
	handler.apply({ yoloModeToggled: true })
	assert.equal(state.yoloModeToggled, true)
	assert.equal(state.mode, "act")
	assert.deepEqual(calls, ["runtimeChanged"])
})
