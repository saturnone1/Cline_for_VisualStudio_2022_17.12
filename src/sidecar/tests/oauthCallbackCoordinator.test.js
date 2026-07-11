const assert = require("node:assert/strict")
const test = require("node:test")
const { OAuthCallbackCoordinator } = require("../dist/features/providers/OAuthCallbackCoordinator")

const logger = { log() {} }
const pending = (overrides = {}) => ({
	provider: "openai-codex",
	state: "state-1",
	callbackUrl: "http://127.0.0.1:1234/oauth/callback",
	createdAt: Date.now(),
	status: "pending",
	...overrides,
})

test("OAuth callback coordinator records query authorization codes", () => {
	const coordinator = new OAuthCallbackCoordinator(logger)
	coordinator.register(pending())
	const result = coordinator.record("http://127.0.0.1:1234/oauth/callback?provider=openai-codex&state=state-1&code=code-1")

	assert.equal(result.success, true)
	assert.equal(result.session.status, "received")
	assert.equal(result.session.code, "code-1")
	assert.equal(coordinator.status("openai-codex", "state-1").hasCode, true)
})

test("OAuth callback coordinator accepts fragment tokens without exposing them in status", () => {
	const coordinator = new OAuthCallbackCoordinator(logger)
	coordinator.register(pending())
	const result = coordinator.record("http://127.0.0.1:1234/oauth/callback?provider=openai-codex&state=state-1#access_token=secret")

	assert.equal(result.success, true)
	assert.equal(result.session.token, "secret")
	assert.equal(coordinator.status("openai-codex", "state-1").hasToken, true)
	assert.equal(JSON.stringify(coordinator.status("openai-codex", "state-1")).includes("secret"), false)
})

test("OAuth callback coordinator prunes expired pending sessions", () => {
	const coordinator = new OAuthCallbackCoordinator(logger, 500)
	const session = pending()
	coordinator.register(session)
	coordinator.prune(session.createdAt + 501)

	assert.equal(coordinator.status("openai-codex", "state-1").success, false)
})
