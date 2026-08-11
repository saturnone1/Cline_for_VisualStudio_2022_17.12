import type { InstructionSettingsCommand } from "../../features/settings/InstructionSettingsRpcHandler"

export function decodeInstructionSettingsRpcCommand(key: string, message: unknown): InstructionSettingsCommand | undefined {
	if (key === "FileService.refreshRules") return { type: "refreshInstructions" }
	if (key === "FileService.refreshSkills") return { type: "refreshSkills" }
	const request = asRecord(message)
	const toggle = { path: readString(request.rulePath) || readString(request.workflowPath) || readString(request.skillPath) || readString(request.path), enabled: request.enabled === true }
	if (["FileService.toggleCursorRule", "FileService.toggleWindsurfRule", "FileService.toggleAgentsRule"].includes(key)) return { type: "toggle", settingType: "rules", request: toggle }
	if (key === "FileService.toggleClineRule") return { type: "toggle", settingType: "rules", request: toggle }
	if (key === "FileService.toggleWorkflow") return { type: "toggle", settingType: "workflows", request: toggle }
	if (key === "FileService.toggleSkill") return { type: "toggle", settingType: "skills", request: toggle }
	return undefined
}

function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function readString(value: unknown) { return typeof value === "string" ? value : "" }
