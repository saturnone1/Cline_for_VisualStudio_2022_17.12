import type { BrowserHandler, BrowserSettings } from "./BrowserHandler"

export type BrowserCommand =
	| Readonly<{ type: "detectedPath" }>
	| Readonly<{ type: "connectionInfo" }>
	| Readonly<{ type: "testConnection"; host: string }>
	| Readonly<{ type: "discover" }>
	| Readonly<{ type: "relaunchInstructions" }>
	| Readonly<{ type: "listTabs" }>
	| Readonly<{ type: "captureScreenshot"; request: Readonly<{ tabId: string }> }>
	| Readonly<{ type: "performAction"; request: BrowserActionRequest }>

export type BrowserActionRequest = Readonly<{
	action: string
	url: string
	tabId: string
	browserSessionId: string
	coordinate: string
	text: string
}>

type Callbacks = Readonly<{
	browser: () => BrowserHandler
	settings: () => BrowserSettings
}>

export class BrowserRpcHandler {
	constructor(private readonly callbacks: Callbacks) {}

	async handle(command: BrowserCommand): Promise<unknown> {
		const browser = this.callbacks.browser()
		const settings = this.callbacks.settings()
		switch (command.type) {
			case "detectedPath": return browser.getDetectedPath(settings)
			case "connectionInfo": return browser.getConnectionInfo(settings)
			case "testConnection": return browser.testConnection(command.host, settings)
			case "discover": return browser.discover(settings)
			case "relaunchInstructions": return relaunchInstructions(settings.remoteBrowserHost)
			case "listTabs": return browser.listTabs(settings)
			case "captureScreenshot": return this.directResult(browser, browser.captureScreenshot(command.request, settings))
			case "performAction": return this.directResult(browser, browser.performAction(command.request, settings))
		}
	}

	private async directResult(browser: BrowserHandler, pending: Promise<unknown>) {
		const result = await pending
		browser.consumeDisplayResult(result)
		return result
	}
}

function relaunchInstructions(remoteBrowserHost: string) {
	const host = remoteBrowserHost || "http://localhost:9222"
	return {
		success: false,
		value: "Automatic Chrome relaunch is not implemented in the Visual Studio host yet. " +
			`Launch Chrome or Edge manually with remote debugging enabled, for example: chrome.exe --remote-debugging-port=9222, then reconnect to ${host}.`,
		message: "Automatic Chrome relaunch is not implemented in the Visual Studio host yet. " +
			`Launch Chrome or Edge manually with remote debugging enabled, then reconnect to ${host}.`,
	}
}
