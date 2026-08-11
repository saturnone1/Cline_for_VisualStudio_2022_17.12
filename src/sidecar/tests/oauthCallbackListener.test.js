const assert = require("node:assert/strict")
const test = require("node:test")
const { NodeOAuthCallbackListener } = require("../dist/infrastructure/auth/NodeOAuthCallbackListener")

test("OAuth callback listener confines HTTP handling to localhost callback routes", async () => {
	const listener = new NodeOAuthCallbackListener(0)
	const received = []
	try {
		const port = await listener.start(async (url) => {
			received.push(url)
			return { success: true, message: "Authorization received." }
		})
		const missing = await fetch(`http://127.0.0.1:${port}/not-a-callback`)
		const callback = await fetch(`http://127.0.0.1:${port}/oauth/callback?state=test`)

		assert.equal(missing.status, 404)
		assert.equal(callback.status, 200)
		assert.match(await callback.text(), /Authorization received/)
		assert.equal(received.length, 1)
	} finally {
		listener.dispose()
	}
})
