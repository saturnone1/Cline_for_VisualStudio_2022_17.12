const assert = require("node:assert/strict")
const test = require("node:test")
const {
	browserActionResultForTranscript,
	normalizeBrowserActionName,
	normalizeBrowserDebugHost,
	normalizeBrowserViewport,
} = require("../dist/infrastructure/browser/BrowserDevToolsAdapter")

test("browser adapter normalizes host, actions, and bounded viewport values", () => {
	assert.equal(normalizeBrowserDebugHost("localhost:9222/"), "http://localhost:9222")
	assert.equal(normalizeBrowserActionName("capture-screenshot"), "screenshot")
	assert.deepEqual(normalizeBrowserViewport({ width: 100, height: 99999 }), { width: 320, height: 4096 })
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
