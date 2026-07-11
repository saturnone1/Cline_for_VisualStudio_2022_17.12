const assert = require("node:assert/strict")
const test = require("node:test")
const { OAuthCallbackCoordinator } = require("../dist/features/providers/OAuthCallbackCoordinator")
const { OAuthCallbackHandler } = require("../dist/features/providers/OAuthCallbackHandler")

function fixture(exchange = async () => {}) {
	const logs = []
	const callbacks = new OAuthCallbackCoordinator({ log: (...args) => logs.push(args) })
	const tokens = { exchangeAuthorizationCode: exchange }
	const credentials = {
		persistOAuthSession: (session) => ({ updates: { storedToken: session.token }, response: { success: true, provider: session.provider, authStatus: "configured", message: "saved" } }),
	}
	return { handler: new OAuthCallbackHandler(callbacks, tokens, credentials, { log: (...args) => logs.push(args) }), callbacks, logs }
}

function pending(overrides = {}) {
	return { provider: "openai-codex", state: "state-1", callbackUrl: "http://127.0.0.1/oauth/callback?provider=openai-codex&state=state-1", createdAt: Date.now(), status: "pending", ...overrides }
}

test("OAuth callback handler persists a callback token through the mutation boundary", async () => {
	const { handler, callbacks } = fixture()
	const session = callbacks.register(pending())
	const mutations = []
	const result = await handler.receive(`${session.callbackUrl}&access_token=secret`, async (mutation) => { mutations.push(mutation); return mutation.response })
	assert.equal(result.success, true)
	assert.equal(mutations[0].updates.storedToken, "secret")
	assert.equal(session.status, "configured")
	assert.equal(handler.status({ provider: "openai-codex", state: session.state }).authStatus, "configured")
})

test("OAuth callback handler exchanges an authorization code before persistence", async () => {
	let exchanged = false
	const { handler, callbacks } = fixture(async (session) => { exchanged = true; session.token = "exchanged-token"; session.status = "received" })
	const session = callbacks.register(pending({ tokenExchange: { tokenUrl: "https://example.com/token", clientId: "client" } }))
	const result = await handler.submit({ callbackUrl: `${session.callbackUrl}&code=authorization-code` }, async (mutation) => mutation.response)
	assert.equal(exchanged, true)
	assert.equal(result.success, true)
	assert.equal(session.status, "configured")
})

test("OAuth callback handler rejects missing and malformed manual callback URLs", async () => {
	const { handler } = fixture()
	const apply = async (mutation) => mutation.response
	assert.equal((await handler.submit({}, apply)).authStatus, "unknown")
	assert.equal((await handler.submit({ callbackUrl: "not a url" }, apply)).success, false)
})

test("OAuth callback handler records token exchange failures without leaking them through the HTTP listener", async () => {
	const { handler, callbacks, logs } = fixture(async () => { throw new Error("exchange unavailable") })
	const session = callbacks.register(pending({ tokenExchange: { tokenUrl: "https://example.com/token", clientId: "client" } }))
	const result = await handler.receive(`${session.callbackUrl}&code=authorization-code`, async (mutation) => mutation.response)
	assert.equal(result.success, true)
	assert.equal(session.status, "error")
	assert.match(session.message, /exchange unavailable/)
	assert.ok(logs.some((entry) => entry[1] === "oauthTokenExchangeFailed"))
})
