const assert = require("node:assert/strict")
const test = require("node:test")
const {
	browserActionResultForTranscript,
	browserActionResultTextForSnapshot,
	normalizeBrowserActionName,
	normalizeBrowserDebugHost,
	normalizeBrowserElements,
	normalizeBrowserUrl,
	normalizeBrowserViewport,
	shouldCaptureBrowserPreview,
} = require("../dist/features/browser/BrowserPolicy")
const { closeDevToolsTab } = require("../dist/infrastructure/browser/BrowserDevToolsAdapter")

test("browser adapter normalizes host, actions, and bounded viewport values", () => {
	assert.equal(normalizeBrowserDebugHost("localhost:9222/"), "http://localhost:9222")
	assert.equal(normalizeBrowserActionName("capture-screenshot"), "screenshot")
	assert.deepEqual(normalizeBrowserViewport({ width: 100, height: 99999 }), { width: 320, height: 4096 })
})

test("every visible browser action captures a preview while close does not", () => {
	for (const action of ["launch", "navigate", "click", "type", "press_enter", "scroll_down", "scroll_up", "screenshot", "future_action"]) {
		assert.equal(shouldCaptureBrowserPreview(action), true, action)
	}
	assert.equal(shouldCaptureBrowserPreview("close"), false)
})

test("browser result normalization repairs markdown URLs and removes noisy hidden elements", () => {
	assert.equal(normalizeBrowserUrl('[](https://broken/%22)<https://www.google.com/search?q=visual+studio&source=hp>'), "https://www.google.com/search?q=visual+studio&source=hp")
	assert.deepEqual(normalizeBrowserElements([
		{ index: 1, tag: "button", label: ".button{display:flex;color:red}", visible: true, x: 1, y: 2 },
		{ index: 2, tag: "a", label: "Learn more", visible: true, x: 3, y: 4 },
		{ index: 3, tag: "input", label: "hidden", visible: false },
	]), [
		{ index: 1, tag: "button", type: "", label: "", x: 1, y: 2, visible: true },
		{ index: 2, tag: "a", type: "", label: "Learn more", x: 3, y: 4, visible: true },
	])
})

test("browser adapter creates a stable transcript DTO", () => {
	assert.deepEqual(browserActionResultForTranscript({
		success: true,
		action: "navigate",
		currentUrl: "https://example.com",
		screenshot: "data:image/png;base64,AAAA",
	}), {
		screenshot: "data:image/png;base64,AAAA",
		screenshotBytes: 3,
		currentUrl: "https://example.com",
		pageText: "",
		elements: [],
		logs: "",
		currentMousePosition: "",
		browserSessionId: "",
		tabId: "",
		url: "",
		title: "",
		action: "navigate",
		status: "",
		error: "",
	})
})

test("browser preview snapshots preserve valid bounded data URIs without truncation", () => {
	const screenshot = `data:image/jpeg;base64,${"A".repeat(32 * 1024)}`
	const text = browserActionResultTextForSnapshot(JSON.stringify({ screenshot, currentUrl: "https://example.com" }))
	const result = JSON.parse(text)
	assert.equal(result.screenshot, screenshot)
	assert.equal(result.currentUrl, "https://example.com")
	assert.ok(result.screenshotBytes > 0)
})

test("browser preview snapshots discard malformed and oversized media", () => {
	assert.equal(JSON.parse(browserActionResultTextForSnapshot(JSON.stringify({ screenshot: "not-an-image" }))).screenshot, "")
	const oversized = `data:image/png;base64,${"A".repeat(3 * 1024 * 1024)}`
	assert.equal(JSON.parse(browserActionResultTextForSnapshot(JSON.stringify({ screenshot: oversized }))).screenshot, "")
})

test("browser close reports an HTTP failure instead of claiming the tab closed", async () => {
	const originalFetch = global.fetch
	global.fetch = async () => ({ ok: false, status: 500 })
	try {
		await assert.rejects(() => closeDevToolsTab("http://localhost:9222", "tab-1"), /HTTP 500/)
	} finally {
		global.fetch = originalFetch
	}
})
