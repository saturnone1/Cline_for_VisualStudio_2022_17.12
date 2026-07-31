const assert = require("node:assert/strict")
const test = require("node:test")
const { capabilityRegistry } = require("../dist/application/services/CapabilityRegistry")
const { createSdkCoverageState } = require("../dist/infrastructure/webview/WebviewState")

test("capability registry is the single runtime source for WebView coverage", () => {
	const coverage = capabilityRegistry.coverage()
	const state = createSdkCoverageState(null)
	assert.deepEqual(state.supported, coverage.supported)
	assert.deepEqual(state.partial, coverage.partial)
	assert.deepEqual(state.visualStudioUnsupported, coverage.visualStudioUnsupported)
	assert.equal(new Set([...state.supported, ...state.partial, ...state.visualStudioUnsupported].map((item) => item.id)).size, 30)
})

test("capability registry exposes stable support queries", () => {
	assert.equal(capabilityRegistry.isSupported("sessions"), true)
	assert.equal(capabilityRegistry.isSupported("sdk-checkpoint-diff-streams"), true)
	assert.equal(capabilityRegistry.isSupported("mcp-marketplace"), false)
	assert.equal(capabilityRegistry.get("mcp-marketplace").status, "partial")
	assert.match(capabilityRegistry.get("vscode-auth").reason, /Visual Studio 2022/)
	assert.equal(capabilityRegistry.get("missing"), undefined)
})
