import type { AgentMode } from "../providers/ProviderSelection"

export function resolveRequestedPlanActMode(message: unknown, currentMode: string): AgentMode {
	const record = message !== null && typeof message === "object" && !Array.isArray(message) ? message as Record<string, unknown> : {}
	const raw = String(record.mode ?? record.value ?? "").toLowerCase()
	if (raw === "plan" || raw === "planactmode.plan" || raw === "0") return "plan"
	if (raw === "act" || raw === "planactmode.act" || raw === "1") return "act"
	return currentMode === "plan" ? "act" : "plan"
}
