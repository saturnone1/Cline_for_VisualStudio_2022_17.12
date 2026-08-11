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
		connectionChanged: () => calls.push("connectionChanged"),
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

test("provider and context changes update the active connection without rebuilding runtime policy", () => {
	const state = { apiConfiguration: { actModeApiProvider: "openai", actModeOpenAiModelId: "old" } }
	const { handler, calls } = createHandler(state)
	handler.apply({ apiConfiguration: { actModeOpenAiModelId: "new", actModeOpenAiModelInfo: { contextWindow: 8192 } } })
	assert.equal(state.apiConfiguration.actModeOpenAiModelId, "new")
	assert.equal(state.apiConfiguration.actModeOpenAiModelInfo.contextWindow, 8192)
	assert.deepEqual(calls, ["connectionChanged"])
})

test("enabling Yolo mode switches the runtime to Act mode", () => {
	const state = { mode: "plan", yoloModeToggled: false }
	const { handler, calls } = createHandler(state)
	handler.apply({ yoloModeToggled: true })
	assert.equal(state.yoloModeToggled, true)
	assert.equal(state.mode, "act")
	assert.deepEqual(calls, ["runtimeChanged"])
})

test("automatic compaction records an explicit preference for future default migrations", () => {
	const state = { useAutoCondense: true }
	const { handler, calls } = createHandler(state)
	handler.apply({ useAutoCondense: false })
	assert.equal(state.useAutoCondense, false)
	assert.equal(state.autoCondensePreferenceVersion, 1)
	assert.deepEqual(calls, ["runtimeChanged"])
})

test("display and independently managed features do not replace the active SDK session", () => {
	const state = { scheduledAgentsEnabled: false, hooksEnabled: false, showFeatureTips: false }
	const { handler, calls } = createHandler(state)

	handler.apply({ scheduledAgentsEnabled: true, hooksEnabled: true, showFeatureTips: true })

	assert.equal(state.scheduledAgentsEnabled, true)
	assert.equal(state.hooksEnabled, true)
	assert.equal(state.showFeatureTips, true)
	assert.deepEqual(calls, [])
})

test("session configuration changes still replace the active SDK session on the next turn", () => {
	const state = { customPrompt: "" }
	const { handler, calls } = createHandler(state)

	handler.apply({ customPrompt: "Use repository conventions." })

	assert.equal(state.customPrompt, "Use repository conventions.")
	assert.deepEqual(calls, ["runtimeChanged"])
})

test("terminal settings update live state without replacing the SDK session", () => {
	const state = {
		terminalReuseEnabled: true,
		terminalOutputLineLimit: 500,
		defaultTerminalProfile: "visual-studio-command-host",
	}
	const { handler, calls } = createHandler(state)

	handler.apply({
		terminalReuseEnabled: false,
		terminalOutputLineLimit: 900,
		defaultTerminalProfile: "windows-powershell",
	})

	assert.equal(state.terminalReuseEnabled, false)
	assert.equal(state.terminalOutputLineLimit, 900)
	assert.equal(state.defaultTerminalProfile, "windows-powershell")
	assert.deepEqual(calls, [])
})
