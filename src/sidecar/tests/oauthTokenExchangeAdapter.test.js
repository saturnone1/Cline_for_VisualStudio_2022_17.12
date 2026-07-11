const assert = require("node:assert/strict")
const test = require("node:test")
const { FetchOAuthTokenExchangeAdapter } = require("../dist/infrastructure/auth/FetchOAuthTokenExchangeAdapter")

test("OAuth token adapter uses Basic auth without duplicating the client secret in the body", async () => {
	const originalFetch = global.fetch
	let captured
	global.fetch = async (_url, options) => {
		captured = options
		return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 30 }) }
	}
	try {
		const result = await new FetchOAuthTokenExchangeAdapter().exchangeAuthorizationCode({ tokenUrl: "https://example.com/token", clientId: "client", clientSecret: "secret", authMethod: "client_secret_basic", code: "code", redirectUri: "http://127.0.0.1/callback" })
		assert.equal(captured.headers.authorization, `Basic ${Buffer.from("client:secret").toString("base64")}`)
		assert.equal(captured.body.get("client_secret"), null)
		assert.equal(result.accessToken, "access")
	} finally { global.fetch = originalFetch }
})

test("OAuth token adapter surfaces sanitized endpoint errors", async () => {
	const originalFetch = global.fetch
	global.fetch = async () => ({ ok: false, status: 401, statusText: "Unauthorized", text: async () => JSON.stringify({ error_description: "invalid client" }) })
	try {
		await assert.rejects(() => new FetchOAuthTokenExchangeAdapter().exchangeAuthorizationCode({ tokenUrl: "https://example.com/token", clientId: "client", code: "code", redirectUri: "http://127.0.0.1/callback" }), /HTTP 401: invalid client/)
	} finally { global.fetch = originalFetch }
})
