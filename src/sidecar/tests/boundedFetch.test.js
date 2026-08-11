const assert = require("node:assert/strict")
const test = require("node:test")
const { fetchBoundedText } = require("../dist/infrastructure/network/BoundedFetch")
const { readHistoryLimit } = require("../dist/infrastructure/webview/TaskHistoryComposition")

test("bounded fetch rejects oversized response bodies", async () => {
	const originalFetch = global.fetch
	global.fetch = async () => new Response("0123456789", { status: 200 })
	try {
		await assert.rejects(
			() => fetchBoundedText("https://example.com", {}, { timeoutMs: 1000, maximumBytes: 5 }),
			/5-byte limit/,
		)
	} finally {
		global.fetch = originalFetch
	}
})

test("bounded fetch propagates caller cancellation", async () => {
	const originalFetch = global.fetch
	global.fetch = async (_url, options) => new Promise((_resolve, reject) => {
		options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true })
	})
	const controller = new AbortController()
	try {
		const pending = fetchBoundedText("https://example.com", {}, { timeoutMs: 1000, maximumBytes: 100, signal: controller.signal })
		controller.abort()
		await assert.rejects(() => pending, /cancelled/)
	} finally {
		global.fetch = originalFetch
	}
})

test("history synchronization uses a bounded configurable limit", () => {
	const previous = process.env.VSCLINE_HISTORY_SYNC_LIMIT
	try {
		delete process.env.VSCLINE_HISTORY_SYNC_LIMIT
		assert.equal(readHistoryLimit(), 2000)
		process.env.VSCLINE_HISTORY_SYNC_LIMIT = "25000"
		assert.equal(readHistoryLimit(), 10000)
		process.env.VSCLINE_HISTORY_SYNC_LIMIT = "125"
		assert.equal(readHistoryLimit(), 125)
	} finally {
		if (previous === undefined) delete process.env.VSCLINE_HISTORY_SYNC_LIMIT
		else process.env.VSCLINE_HISTORY_SYNC_LIMIT = previous
	}
})
