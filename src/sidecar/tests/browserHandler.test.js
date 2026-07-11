const assert = require("node:assert/strict")
const test = require("node:test")
const { BrowserHandler } = require("../dist/features/browser/BrowserHandler")

const enabledSettings = {
	remoteBrowserEnabled: true,
	remoteBrowserHost: "localhost:9222",
	chromeExecutablePath: "",
	disableToolUse: false,
	viewport: { width: 900, height: 600 },
	webFetchEnabled: true,
	webFetchDisabledReason: "",
}

test("browser handler keeps disabled tool use inside the feature boundary", async () => {
	let calls = 0
	const automation = {
		resolveExecutablePath: () => "",
		fetchDebugInfo: async () => ({ success: true }),
		listTabs: async () => { calls++; return { success: true, tabs: [] } },
		runAction: async () => { calls++; return { success: true } },
	}
	const handler = new BrowserHandler(automation, () => "unused")
	const settings = { ...enabledSettings, disableToolUse: true }

	assert.deepEqual(await handler.listTabs(settings), {
		success: false,
		tabs: [],
		error: "Browser tool usage is disabled in Visual Studio settings.",
	})
	assert.equal((await handler.performAction({ action: "navigate" }, settings)).status, "error")
	assert.equal(calls, 0)
})

test("browser handler owns action phases and reuses its browser session", async () => {
	const requests = []
	let id = 0
	const automation = {
		resolveExecutablePath: () => "",
		fetchDebugInfo: async () => ({ success: true }),
		listTabs: async () => ({ success: true, tabs: [] }),
		runAction: async (_host, request) => {
			requests.push(request)
			request.onPhase({ phase: "connected", tabId: "tab-1" })
			return { success: true, status: "completed", tabId: "tab-1", currentUrl: request.url || "https://example.com" }
		},
	}
	const handler = new BrowserHandler(automation, () => String(++id))
	const first = await handler.performAction({ action: "navigate", url: "https://example.com", tabId: "tab-1" }, enabledSettings)
	const second = await handler.performAction({ action: "screenshot", browserSessionId: first.browserSessionId }, enabledSettings)

	assert.equal(first.browserSessionId, "browser-1")
	assert.equal(second.browserSessionId, first.browserSessionId)
	assert.equal(requests[1].tabId, "tab-1")
	assert.equal(first.phases[0].browserActionId, "browser-action-2")
})
