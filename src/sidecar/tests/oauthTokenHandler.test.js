const assert = require("node:assert/strict")
const test = require("node:test")
const { OAuthTokenHandler } = require("../dist/features/providers/OAuthTokenHandler")

test("OAuth token handler projects exchange results onto the pending session", async () => {
	const requests = []
	const exchange = { exchangeAuthorizationCode: async (request) => { requests.push(request); return { accessToken: "access", refreshToken: "refresh", tokenType: "Bearer", expiresIn: 60, rawResponse: { scope: "read" } } } }
	const handler = new OAuthTokenHandler(exchange, { log() {} })
	const session = { provider: "openai-codex", state: "state", callbackUrl: "http://127.0.0.1/callback", createdAt: Date.now(), status: "received", code: "code", tokenExchange: { tokenUrl: "https://example.com/token", clientId: "client" } }

	await handler.exchangeAuthorizationCode(session)

	assert.equal(requests[0].redirectUri, session.callbackUrl)
	assert.equal(session.token, "access")
	assert.equal(session.refreshToken, "refresh")
	assert.equal(session.status, "received")
	assert.deepEqual(session.tokenResponse, { scope: "read" })
})

test("OAuth token handler does not call transport without a code", async () => {
	let called = false
	const handler = new OAuthTokenHandler({ exchangeAuthorizationCode: async () => { called = true } }, { log() {} })
	const session = { provider: "account", state: "state", callbackUrl: "http://127.0.0.1/callback", createdAt: Date.now(), status: "received" }

	assert.equal(await handler.exchangeAuthorizationCode(session), session)
	assert.equal(called, false)
})
