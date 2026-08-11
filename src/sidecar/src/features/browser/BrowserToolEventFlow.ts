import type { BrowserHandler, BrowserSettings } from "./BrowserHandler"
import { browserActionResultForTranscript, normalizeBrowserActionName } from "./BrowserPolicy"

type BrowserToolEventDependencies = {
	browser: () => BrowserHandler
	settings: () => BrowserSettings
	addMessage: (message: Record<string, unknown>) => void
	updateTask: () => void
	broadcast: () => Promise<void>
}

export class BrowserToolEventFlow {
	constructor(private readonly dependencies: BrowserToolEventDependencies) {}

	async execute(toolName: string, input: Record<string, unknown>, error: string, completedOutput?: unknown) {
		const output = asRecord(completedOutput)
		const browser = this.dependencies.browser()
		const displayOutput = browser.consumeDisplayResult?.(output) || output
		const action = normalizeBrowserActionName(stringValue(input.action) || stringValue(input.name) || stringValue(output.action) || toolName)
		const url = stringValue(input.url) || stringValue(input.value) || stringValue(output.currentUrl) || stringValue(output.url)
		if (action === "launch" || action === "navigate") {
			this.dependencies.addMessage({ type: "say", say: "browser_action_launch", text: url || "" })
		} else {
			this.dependencies.addMessage({
				type: "say",
				say: "browser_action",
				text: JSON.stringify({ action, coordinate: stringValue(input.coordinate), text: stringValue(input.text) }),
			})
		}

		let result: Record<string, unknown>
		try {
			result = error
				? { success: false, status: "error", error }
				: Object.keys(displayOutput).length > 0
					? displayOutput
					: asRecord(await this.dependencies.browser().performAction({ ...input, action }, this.dependencies.settings()))
		} catch (actionError) {
			result = { success: false, status: "error", error: stringify(actionError) }
		}
		this.dependencies.addMessage({ type: "say", say: "browser_action_result", text: JSON.stringify(browserActionResultForTranscript(result)) })
		this.dependencies.updateTask()
		await this.dependencies.broadcast()
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function stringValue(value: unknown) { return typeof value === "string" ? value : "" }
function stringify(value: unknown) { return value instanceof Error ? value.message : String(value) }
