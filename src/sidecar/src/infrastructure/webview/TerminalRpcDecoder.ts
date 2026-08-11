import type { TerminalCommand } from "../../features/terminal/TerminalRpcHandler"

export function decodeTerminalRpcCommand(key: string, message: unknown): TerminalCommand | undefined {
	const request = asRecord(message)
	const identifiers = { terminalId: optionalString(request.terminalId), commandId: optionalString(request.commandId) }
	switch (key) {
		case "StateService.getAvailableTerminalProfiles": return { type: "profiles" }
		case "TerminalService.openTerminalPanel":
		case "UiService.openTerminalPanel": return { type: "open", ...identifiers }
		case "TerminalService.attachTerminalCommand":
		case "UiService.attachTerminalCommand": return { type: "attach", ...identifiers }
		case "TerminalService.continueTerminalCommand":
		case "UiService.continueTerminalCommand": return { type: "continue", ...identifiers }
		default: return undefined
	}
}

function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function optionalString(value: unknown) { return typeof value === "string" && value ? value : undefined }
