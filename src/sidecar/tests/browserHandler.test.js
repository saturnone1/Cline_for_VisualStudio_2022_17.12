const assert = require("node:assert/strict")
const test = require("node:test")
const { BrowserHandler } = require("../dist/features/browser/BrowserHandler")
const { compactBrowserAgentResult, createBrowserAgentTool } = require("../dist/features/browser/BrowserAgentTool")
const { BrowserToolEventFlow } = require("../dist/features/browser/BrowserToolEventFlow")

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

test("browser agent tool is exposed only when browser tool use is enabled", async () => {
	const calls = []
	const browser = { performAction: async (input, settings) => { calls.push({ input, settings }); return { success: true, currentUrl: input.url } } }
	const enabledTool = createBrowserAgentTool(browser, () => enabledSettings)
	const disabledTool = createBrowserAgentTool(browser, () => ({ ...enabledSettings, disableToolUse: true }))

	assert.equal(enabledTool.name, "browser_action")
	assert.equal(disabledTool, undefined)
	assert.deepEqual(await enabledTool.execute({ action: "launch", url: "https://www.google.com" }), { success: true, currentUrl: "https://www.google.com", screenshot: undefined, screenshotBytes: 0, phases: undefined })
	assert.equal(calls.length, 1)
})

test("browser agent results never return base64 screenshots as JSON context", () => {
	const compact = compactBrowserAgentResult({ success: true, screenshot: "data:image/png;base64,QUJDRA==", phases: [{ phase: "capturing" }] })
	assert.equal(compact.screenshot, undefined)
	assert.equal(compact.screenshotBytes, 4)
	assert.equal(compact.phases, undefined)
	assert.equal(JSON.stringify(compact).includes("QUJDRA=="), false)
})

test("local browser actions ensure the DevTools browser is available before execution", async () => {
	let ensured = 0
	let actions = 0
	const automation = {
		resolveExecutablePath: () => "C:\\Browser\\browser.exe",
		ensureAvailable: async () => { ensured++; return { success: true } },
		fetchDebugInfo: async () => ({ success: false }),
		listTabs: async () => ({ success: true, tabs: [] }),
		runAction: async () => { actions++; return { success: true, currentUrl: "https://www.google.com" } },
	}
	const handler = new BrowserHandler(automation, () => "id")
	const localSettings = { ...enabledSettings, remoteBrowserEnabled: false }

	const result = await handler.performAction({ action: "launch", url: "https://www.google.com" }, localSettings)
	assert.equal(result.success, true)
	assert.equal(ensured, 1)
	assert.equal(actions, 1)
})

test("browser event projection reuses the SDK tool result without executing the action twice", async () => {
	let actions = 0
	const messages = []
	const flow = new BrowserToolEventFlow({
		browser: () => ({ performAction: async () => { actions++; return { success: true } } }),
		settings: () => enabledSettings,
		addMessage: (message) => messages.push(message),
		updateTask: () => undefined,
		broadcast: async () => undefined,
	})

	await flow.execute("browser_action", { action: "launch", url: "https://www.google.com" }, "", { success: true, currentUrl: "https://www.google.com" })
	assert.equal(actions, 0)
	assert.equal(messages.at(-1).say, "browser_action_result")
})
