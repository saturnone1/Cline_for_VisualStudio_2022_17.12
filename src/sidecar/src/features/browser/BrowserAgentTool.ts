import type { BrowserHandler, BrowserSettings } from "./BrowserHandler"
import { screenshotByteLength } from "./BrowserPolicy"

export function createBrowserAgentTool(browser: BrowserHandler, settings: () => BrowserSettings, timeoutMs = 30_000) {
	if (settings().disableToolUse) return undefined
	return {
		name: "browser_action",
		description: "Open and inspect web pages in the LIG VS controlled Chrome or Edge browser. Use this when the user asks to open a URL, check the current page, click, type, scroll, take a screenshot, or close the controlled tab.",
		inputSchema: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["launch", "navigate", "screenshot", "click", "type", "press_enter", "scroll_down", "scroll_up", "close"] },
				url: { type: "string", description: "URL for launch or navigate." },
				coordinate: { type: "string", description: "Click position formatted as x,y." },
				text: { type: "string", description: "Text to enter for the type action." },
				tabId: { type: "string" },
				browserSessionId: { type: "string" },
			},
			required: ["action"],
			additionalProperties: false,
		},
		timeoutMs,
		execute: async (input: unknown) => compactBrowserAgentResult(await browser.performAction(input, settings())),
	}
}

export function compactBrowserAgentResult(value: unknown) {
	const result = asRecord(value)
	const screenshot = readString(result.screenshot)
	return {
		...result,
		screenshot: undefined,
		screenshotBytes: numberValue(result.screenshotBytes) || screenshotByteLength(screenshot),
		phases: undefined,
	}
}

function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function readString(value: unknown) { return typeof value === "string" ? value : "" }
function numberValue(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : 0 }
