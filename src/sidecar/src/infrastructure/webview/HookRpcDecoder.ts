import type { HookCommand } from "../../features/hooks/HookRpcHandler"
import type { HookMutationRequest } from "../../features/hooks/HookSettingsHandler"

export function decodeHookRpcCommand(key: string, message: unknown): HookCommand | undefined {
	if (key === "FileService.refreshHooks") return { type: "refresh" }
	const request = mutationRequest(message)
	if (key === "FileService.createHook") return { type: "create", request }
	if (key === "FileService.deleteHook") return { type: "delete", request }
	if (key === "FileService.toggleHook") return { type: "toggle", request }
	return undefined
}

function mutationRequest(message: unknown): HookMutationRequest {
	const request = asRecord(message)
	return {
		hookName: readString(request.hookName) || readString(request.name),
		source: request.isGlobal === true ? "global" : "workspace",
		enabled: request.enabled !== false,
	}
}

function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function readString(value: unknown) { return typeof value === "string" ? value : "" }
