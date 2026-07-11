import type { CheckpointCommand } from "../../features/checkpoints/CheckpointRpcHandler"
import type { CheckpointTargetRequest } from "../../features/checkpoints/CheckpointHandler"

export function decodeCheckpointRpcCommand(key: string, message: unknown): CheckpointCommand | undefined {
	const request = asRecord(message)
	const target: CheckpointTargetRequest = {
		checkpointRunCount: optionalNumber(request.checkpointRunCount),
		runCount: optionalNumber(request.runCount),
		messageTs: optionalNumber(request.messageTs) ?? optionalNumber(request.value) ?? optionalNumber(request.number),
		restoreType: optionalString(request.restoreType),
	}
	if (key === "CheckpointsService.checkpointRestore") return { type: "restore", target }
	if (key === "CheckpointsService.checkpointDiff") return { type: "diff", target }
	return undefined
}

function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function optionalNumber(value: unknown) { const number = Number(value); return Number.isFinite(number) ? number : undefined }
function optionalString(value: unknown) { return typeof value === "string" ? value : undefined }
