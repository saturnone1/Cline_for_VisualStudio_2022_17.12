const assert = require("node:assert/strict")
const test = require("node:test")
const { ProviderCredentialHandler } = require("../dist/features/providers/ProviderCredentialHandler")

function fixture(environmentOverrides = {}, tokenOverrides = {}) {
	const environment = { oauthExpirySkewMs: 60_000, resolveApiKey: () => "", resolveBaseUrl: () => "", createTokenExchangeConfig: () => null, ...environmentOverrides }
	const tokens = { exchangeAuthorizationCode: async () => { throw new Error("unused") }, refreshAccessToken: async () => { throw new Error("unused") }, ...tokenOverrides }
	return new ProviderCredentialHandler(environment, tokens)
}

test("provider credential handler returns explicit API key and base URL mutations", () => {
	const mutation = fixture().save({ provider: "openrouter", apiKey: "secret", baseUrl: "https://openrouter.example" })
	assert.deepEqual(mutation.updates, { openRouterApiKey: "secret", openRouterBaseUrl: "https://openrouter.example" })
	assert.equal(mutation.response.authStatus, "configured")
})

test("provider credential status distinguishes environment credentials without persisting them", () => {
	const handler = fixture({ resolveApiKey: () => "from-env" })
	const status = handler.status({ provider: "anthropic" }, {})
	assert.equal(status.authStatus, "environment")
	assert.equal(status.hasCredential, false)
	assert.equal(status.hasEnvironmentCredential, true)
})

test("provider credential handler refreshes OAuth blobs through the token port", async () => {
	const environment = { createTokenExchangeConfig: () => ({ tokenUrl: "https://example.com/token", clientId: "client" }) }
	const handler = fixture(environment, { refreshAccessToken: async () => ({ accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 60, rawResponse: {} }) })
	const configuration = { openAiCodexOAuthCredentials: JSON.stringify({ accessToken: "old", refreshToken: "refresh" }) }
	const mutation = await handler.refresh({ provider: "openai-codex" }, configuration)
	const stored = JSON.parse(mutation.updates.openAiCodexOAuthCredentials)
	assert.equal(stored.accessToken, "new-access")
	assert.equal(stored.refreshToken, "new-refresh")
	assert.equal(mutation.openAiCodexAuthenticated, true)
})

test("provider credential handler clears OAuth blob fields without exposing values", () => {
	const mutation = fixture().clear({ provider: "openai-codex" })
	assert.deepEqual(mutation.deletes, ["openAiCodexOAuthCredentials"])
	assert.equal(JSON.stringify(mutation.response).includes("secret"), false)
})
