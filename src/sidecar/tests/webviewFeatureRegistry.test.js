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
