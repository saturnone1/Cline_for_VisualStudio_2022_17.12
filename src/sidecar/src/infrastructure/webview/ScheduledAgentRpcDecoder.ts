import type { ScheduledAgentSpecInput } from "../../application/ports/ScheduledAgentStorePort"
import type { ScheduledAgentCommand } from "../../features/scheduledAgents/ScheduledAgentRpcHandler"

export function decodeScheduledAgentRpcCommand(key: string, message: unknown): ScheduledAgentCommand | undefined {
	if (["ScheduledAgentsService.listSpecs", "ScheduledAgentsService.listScheduledAgents", "AutomationService.listScheduledAgents"].includes(key)) return { type: "list" }
	const request = specInput(message)
	if (["ScheduledAgentsService.createSpec", "ScheduledAgentsService.updateSpec", "ScheduledAgentsService.saveSpec", "AutomationService.saveScheduledAgent"].includes(key)) return { type: "save", request }
	if (["ScheduledAgentsService.deleteSpec", "ScheduledAgentsService.deleteScheduledAgent", "AutomationService.deleteScheduledAgent"].includes(key)) return { type: "delete", request }
	if (["ScheduledAgentsService.runSpec", "ScheduledAgentsService.runScheduledAgent", "AutomationService.runScheduledAgent"].includes(key)) return { type: "run", request }
	return undefined
}

function specInput(message: unknown): ScheduledAgentSpecInput {
	const request = asRecord(message)
	return {
		id: readString(request.id), specId: readString(request.specId), name: readString(request.name), fileName: readString(request.fileName),
		description: readString(request.description), schedule: readString(request.schedule), cron: readString(request.cron),
		prompt: readString(request.prompt), task: readString(request.task), text: readString(request.text),
		enabled: request.enabled === undefined ? undefined : request.enabled !== false,
	}
}

function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function readString(value: unknown) { return typeof value === "string" ? value : value == null ? "" : String(value) }
