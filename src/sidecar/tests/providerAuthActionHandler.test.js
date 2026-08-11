const assert = require("node:assert/strict")
const test = require("node:test")
const { ProviderAuthActionHandler } = require("../dist/features/providers/ProviderAuthActionHandler")

function fixture() {
	const opened = [], messages = [], logs = []
	const ui = { openExternal: async (url) => opened.push(url), showMessage: async (message, type) => messages.push({ message, type }) }
	return { handler: new ProviderAuthActionHandler(ui, { log: (...args) => logs.push(args) }), opened, messages, logs }
}

test("provider auth action opens API key pages and informational messages", async () => {
	const { handler, opened, messages } = fixture()
	const result = await handler.execute("openrouter", {}, null)
	assert.deepEqual(opened, ["https://openrouter.ai/settings/keys"])
	assert.equal(messages[0].type, "info")
	assert.equal(result.authMode, "api_key")
})

test("provider auth action opens OAuth authorization URL from the prepared bridge", async () => {
	const { handler, opened } = fixture()
	const bridge = { provider: "openai-codex", state: "state", callbackUrl: "http://127.0.0.1/callback", authorizationUrl: "https://login.example/authorize", createdAt: Date.now(), status: "pending", tokenExchangeSupported: true }
	const result = await handler.execute("openAiCodex", {}, bridge)
	assert.deepEqual(opened, [bridge.authorizationUrl])
	assert.equal(result.authStatus, "pending")
	assert.equal(result.tokenExchangeSupported, true)
})

test("provider auth action warns for unsupported providers without opening a URL", async () => {
	const { handler, opened, messages } = fixture()
	const result = await handler.execute("unknown-provider", {}, null)
	assert.deepEqual(opened, [])
	assert.equal(messages[0].type, "warning")
	assert.equal(result.supported, false)
})
