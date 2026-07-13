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
		const action = normalizeBrowserActionName(stringValue(input.action) || stringValue(input.name) || toolName)
		const url = stringValue(input.url) || stringValue(input.value)
		if (action === "launch" || action === "navigate") {
			this.dependencies.addMessage({ type: "say", say: "browser_action_launch", text: url || "" })
		} else {
			this.dependencies.addMessage({
				type: "say",
				say: "browser_action",
				text: JSON.stringify({ action, coordinate: stringValue(input.coordinate), text: stringValue(input.text) }),
			})
		}

		const output = asRecord(completedOutput)
		const result: Record<string, unknown> = error
			? { success: false, status: "error", error }
			: Object.keys(output).length > 0
				? output
				: asRecord(await this.dependencies.browser().performAction({ ...input, action }, this.dependencies.settings()))
		for (const phase of arrayOfRecords(result.phases)) {
			this.dependencies.addMessage({
				type: "say",
				say: "browser_action",
				text: JSON.stringify({
					action,
					phase: stringValue(phase.phase),
					tabId: stringValue(phase.tabId),
					browserSessionId: stringValue(phase.browserSessionId),
					browserActionId: stringValue(phase.browserActionId),
					reconnectReason: stringValue(phase.reconnectReason),
				}),
			})
		}
		this.dependencies.addMessage({ type: "say", say: "browser_action_result", text: JSON.stringify(browserActionResultForTranscript(result)) })
		this.dependencies.updateTask()
		await this.dependencies.broadcast()
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function arrayOfRecords(value: unknown) { return Array.isArray(value) ? value.map(asRecord) : [] }
function stringValue(value: unknown) { return typeof value === "string" ? value : "" }
