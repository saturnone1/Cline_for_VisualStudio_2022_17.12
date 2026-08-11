const assert = require("node:assert/strict")
const test = require("node:test")
const { BrowserHandler } = require("../dist/features/browser/BrowserHandler")
const { compactBrowserAgentResult, createBrowserAgentTool } = require("../dist/features/browser/BrowserAgentTool")
const { BrowserToolEventFlow } = require("../dist/features/browser/BrowserToolEventFlow")
const { BrowserRpcHandler } = require("../dist/features/browser/BrowserRpcHandler")

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
	const compact = compactBrowserAgentResult({ success: true, screenshot: "data:image/png;base64,QUJDRA==", phases: [{ phase: "capturing" }], currentUrl: '[](https://broken/%22)<https://example.com/>', elements: [{ index: 1, tag: "a", label: "Visible", visible: true }, { index: 2, tag: "div", label: "Hidden", visible: false }] })
	assert.equal(compact.screenshot, undefined)
	assert.equal(compact.screenshotBytes, 4)
	assert.equal(compact.phases, undefined)
	assert.equal(compact.currentUrl, "https://example.com/")
	assert.equal(compact.elements.length, 1)
	assert.equal(JSON.stringify(compact).includes("QUJDRA=="), false)
})

test("browser display results retain screenshots outside the model result", async () => {
	const automation = {
		resolveExecutablePath: () => "C:\\Browser\\browser.exe",
		ensureAvailable: async () => ({ success: true }),
		fetchDebugInfo: async () => ({ success: true }),
		listTabs: async () => ({ success: true, tabs: [] }),
		runAction: async () => ({ success: true, action: "screenshot", screenshot: "data:image/png;base64,QUJDRA==" }),
		cancelActive: async () => 0,
	}
	const handler = new BrowserHandler(automation, () => "display")
	const complete = await handler.performAction({ action: "screenshot" }, { ...enabledSettings, remoteBrowserEnabled: true })
	const compact = compactBrowserAgentResult(complete)

	assert.equal(compact.screenshot, undefined)
	assert.equal(handler.consumeDisplayResult(compact).screenshot, "data:image/png;base64,QUJDRA==")
	assert.equal(handler.consumeDisplayResult(compact), undefined)
})

test("browser display results are bounded and direct RPC results are released immediately", async () => {
	let id = 0
	const automation = {
		resolveExecutablePath: () => "C:\\Browser\\browser.exe",
		fetchDebugInfo: async () => ({ success: true }),
		listTabs: async () => ({ success: true, tabs: [] }),
		runAction: async () => ({ success: true, screenshot: "data:image/png;base64,QUJDRA==" }),
	}
	const handler = new BrowserHandler(automation, () => String(++id), 60_000, 2, 1024)
	const first = await handler.performAction({ action: "screenshot" }, enabledSettings)
	await handler.performAction({ action: "screenshot" }, enabledSettings)
	const third = await handler.performAction({ action: "screenshot" }, enabledSettings)
	assert.equal(handler.consumeDisplayResult(first), undefined)
	assert.ok(handler.consumeDisplayResult(third))

	const rpc = new BrowserRpcHandler({ browser: () => handler, settings: () => enabledSettings })
	const direct = await rpc.handle({ type: "performAction", request: { action: "screenshot", url: "", tabId: "", browserSessionId: "", coordinate: "", text: "" } })
	assert.equal(handler.consumeDisplayResult(direct), undefined)
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

test("browser event projection uses the retained UI result without exposing it to the model", async () => {
	const messages = []
	const browser = {
		consumeDisplayResult: () => ({ success: true, action: "screenshot", screenshot: "data:image/png;base64,QUJDRA==", currentUrl: "https://example.com" }),
		performAction: async () => { throw new Error("should not execute") },
	}
	const flow = new BrowserToolEventFlow({
		browser: () => browser,
		settings: () => enabledSettings,
		addMessage: (message) => messages.push(message),
		updateTask: () => undefined,
		broadcast: async () => undefined,
	})

	await flow.execute("browser_action", { action: "screenshot" }, "", { success: true, action: "screenshot", browserActionId: "action-1", screenshotBytes: 4 })
	const result = JSON.parse(messages.at(-1).text)
	assert.equal(result.screenshot, "data:image/png;base64,QUJDRA==")
})

test("browser event projection recovers missing input fields from the completed result", async () => {
	const messages = []
	const flow = new BrowserToolEventFlow({
		browser: () => ({ performAction: async () => { throw new Error("should not execute") } }),
		settings: () => enabledSettings,
		addMessage: (message) => messages.push(message),
		updateTask: () => undefined,
		broadcast: async () => undefined,
	})

	await flow.execute("browser_action", {}, "", { success: true, action: "launch", currentUrl: "https://example.com" })
	assert.equal(messages[0].say, "browser_action_launch")
	assert.equal(messages[0].text, "https://example.com")
})

test("browser event projection keeps transport phases out of the conversation transcript", async () => {
	const messages = []
	const flow = new BrowserToolEventFlow({
		browser: () => ({ performAction: async () => { throw new Error("should not execute") } }),
		settings: () => enabledSettings,
		addMessage: (message) => messages.push(message),
		updateTask: () => undefined,
		broadcast: async () => undefined,
	})

	await flow.execute("browser_action", { action: "close" }, "", {
		success: true,
		action: "close",
		status: "closed",
		phases: [{ phase: "resolving_tab" }, { phase: "closing" }],
	})
	assert.deepEqual(messages.map((message) => message.say), ["browser_action", "browser_action_result"])
	assert.equal(messages.some((message) => message.text.includes("resolving_tab")), false)
})

test("browser event projection turns execution failures into a terminal tool result", async () => {
	const messages = []
	const flow = new BrowserToolEventFlow({
		browser: () => ({ performAction: async () => { throw new Error("browser transport failed") } }),
		settings: () => enabledSettings,
		addMessage: (message) => messages.push(message),
		updateTask: () => undefined,
		broadcast: async () => undefined,
	})

	await flow.execute("browser_action", { action: "screenshot" }, "", undefined)
	const result = JSON.parse(messages.at(-1).text)
	assert.equal(result.status, "error")
	assert.match(result.error, /browser transport failed/)
})
