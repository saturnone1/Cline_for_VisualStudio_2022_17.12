import type { AgentEnginePort, AgentRestoreRequest } from "../../application/ports/AgentEnginePort"
import { createCheckpointDiffDescription, findCheckpointMessage, findCheckpointRunCount, resolveCheckpointRestoreScope } from "./CheckpointPolicy"

type RestoreContext = Readonly<{ taskItem: Record<string, unknown>; messages: readonly Record<string, unknown>[]; cwd: string; config: Readonly<Record<string, unknown>>; toolPolicies: Readonly<Record<string, unknown>> }>
type CompareContext = Readonly<{ taskItem?: Record<string, unknown>; messages: readonly Record<string, unknown>[]; trackedChanges: readonly Record<string, unknown>[] }>

export class CheckpointHandler {
	constructor(private readonly agentEngine: AgentEnginePort) {}

	async restore(message: unknown, context: RestoreContext) {
		const request = asRecord(message), checkpointRunCount = targetRunCount(request, context.messages)
		if (checkpointRunCount === undefined) throw new Error("No SDK checkpoint run count is available for this restore target.")
		const restoreRequest: AgentRestoreRequest = { sessionId: readString(context.taskItem.id), checkpointRunCount, cwd: context.cwd, restore: resolveCheckpointRestoreScope(readString(request.restoreType)).restore, start: { config: context.config, interactive: true, toolPolicies: context.toolPolicies } }
		const result = asRecord(await this.agentEngine.restore(restoreRequest))
		return { checkpointRunCount, restoredSessionId: readString(result.sessionId) || readString(asRecord(result.startResult).sessionId) }
	}

	describe(message: unknown, context: CompareContext) {
		if (!context.taskItem) return { success: false as const, supported: false as const, message: "No SDK-backed task is selected for checkpoint compare." }
		const request = asRecord(message), messageTs = readNumber(request.messageTs) ?? readNumber(request.value) ?? readNumber(request.number)
		const checkpointRunCount = targetRunCount(request, context.messages, messageTs)
		if (checkpointRunCount === undefined) return { success: false as const, supported: false as const, message: "No SDK checkpoint run count is available for this compare target." }
		const checkpointMessage = findCheckpointMessage(context.messages, checkpointRunCount, messageTs)
		return createCheckpointDiffDescription({ checkpointRunCount, sessionId: readString(context.taskItem.id), workspaceRoot: readString(checkpointMessage?.checkpointWorkspaceRoot) || readString(context.taskItem.cwdOnTaskInitialization), createdAt: readNumber(checkpointMessage?.ts), trackedChanges: context.trackedChanges })
	}
}

function targetRunCount(request: Record<string, unknown>, messages: readonly Record<string, unknown>[], messageTs = readNumber(request.messageTs)) { return readNumber(request.checkpointRunCount) ?? readNumber(request.runCount) ?? findCheckpointRunCount(messages, messageTs) }
function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function readString(value: unknown) { return typeof value === "string" ? value : value == null ? "" : String(value) }
function readNumber(value: unknown) { const number = Number(value); return Number.isFinite(number) ? number : undefined }
