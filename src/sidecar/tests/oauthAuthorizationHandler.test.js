const assert = require("node:assert/strict")
const test = require("node:test")
const { OAuthAuthorizationHandler } = require("../dist/features/providers/OAuthAuthorizationHandler")
const { OAuthCallbackCoordinator } = require("../dist/features/providers/OAuthCallbackCoordinator")

function createFixture(authorizationUrl = "https://auth.example/authorize") {
	const logs = []
	let starts = 0
	const logger = { log: (...args) => logs.push(args) }
	const callbacks = new OAuthCallbackCoordinator(logger)
	const listener = {
		start: async (callback) => { starts += 1; listener.callback = callback; return 43123 },
		dispose() {},
	}
	const authorization = {
		create: (provider, callbackUrl, state) => ({
			url: authorizationUrl,
			tokenExchangeSupported: true,
			tokenExchange: { tokenUrl: "https://auth.example/token", clientId: "client" },
			provider,
			callbackUrl,
			state,
		}),
	}
	let nextId = 0
	const handler = new OAuthAuthorizationHandler(callbacks, listener, authorization, logger, () => `state-${++nextId}`)
	return { handler, callbacks, listener, logs, starts: () => starts }
}

test("creates and registers an OAuth authorization session", async () => {
	const fixture = createFixture()
	const session = await fixture.handler.ensure("anthropic", {}, async () => ({ success: true, message: "ok" }))
	assert.equal(session.state, "state-1")
	assert.equal(session.callbackUrl, "http://127.0.0.1:43123/oauth/callback?provider=anthropic&state=state-1")
	assert.equal(session.authorizationUrl, "https://auth.example/authorize")
	assert.equal(fixture.callbacks.latest("anthropic"), session)
	assert.equal(fixture.starts(), 1)
	assert.ok(fixture.logs.some((entry) => entry[1] === "oauthCallbackBridgeReady"))
})

test("reuses the callback listener and creates independent sessions", async () => {
	const fixture = createFixture("")
	const callback = async () => ({ success: true, message: "ok" })
	const first = await fixture.handler.ensure("account", {}, callback)
	const second = await fixture.handler.ensure("account", {}, callback)
	assert.equal(fixture.starts(), 1)
	assert.notEqual(first.state, second.state)
	assert.match(fixture.handler.response(second).message, /callback bridge is ready/)
})

test("projects the browser authorization response", async () => {
	const fixture = createFixture()
	const session = await fixture.handler.ensure("openAiCodex", {}, async () => ({ success: true, message: "ok" }))
	const response = fixture.handler.response(session)
	assert.equal(response.success, true)
	assert.equal(response.authorizationUrl, "https://auth.example/authorize")
	assert.equal(response.redirectUrl, session.callbackUrl)
	assert.equal(response.tokenExchangeSupported, true)
})
