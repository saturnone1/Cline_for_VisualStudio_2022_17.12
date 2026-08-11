const assert = require("node:assert/strict")
const test = require("node:test")
const { WebviewFeatureRegistry } = require("../dist/infrastructure/webview/WebviewFeatureRegistry")

test("WebView feature registry preserves attached service identity", () => {
	const registry = new WebviewFeatureRegistry()
	const runtime = { status: { activeSessionId: null } }
	registry.attach("agentEngine", runtime)

	assert.equal(registry.optional("agentEngine"), runtime)
	assert.equal(registry.require("agentEngine"), runtime)
	assert.equal(registry.optional("mcp"), null)
})

test("WebView feature registry reports the stable feature label when missing", () => {
	const registry = new WebviewFeatureRegistry()
	assert.throws(() => registry.require("streamPublisher"), /Webview stream publisher is not attached\./)
	assert.throws(() => registry.require("mcp"), /LIG VS MCP application service is not attached\./)
})

test("WebView feature registry activates a complete feature set exactly once", () => {
	const registry = new WebviewFeatureRegistry()
	const feature = {}
	registry.attach("streamPublisher", feature)
	const runtimeFeatures = {
		agentEngine: feature,
		taskSessions: feature,
		mcp: feature,
		sendMessage: feature,
		startTask: feature,
		cancelTask: feature,
		browser: feature,
		worktreeQueries: feature,
		worktreeMutations: feature,
		oauthAuthorization: feature,
		oauthCallback: feature,
		providerCredentials: feature,
		providerAuthActions: feature,
		scheduledAgents: feature,
		hookSettings: feature,
		hookExecution: feature,
		checkpoints: feature,
		terminalActivity: feature,
		taskActivity: feature,
		partialState: feature,
		sendLatency: feature,
		changeTracking: feature,
		providerModelCatalogs: feature,
		sdkSettings: feature,
	}

	registry.complete(runtimeFeatures)

	assert.equal(registry.require("agentEngine"), feature)
	assert.throws(() => registry.complete(runtimeFeatures), /already configured/)
	assert.throws(() => registry.attach("mcp", feature), /already configured/)
})

test("WebView feature registry rejects incomplete activation", () => {
	const registry = new WebviewFeatureRegistry()
	registry.attach("streamPublisher", {})

	assert.throws(() => registry.complete({}), /configuration is incomplete/)
})
