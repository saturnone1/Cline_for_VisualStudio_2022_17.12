export type CheckpointRestoreScope = "task" | "workspace" | "taskAndWorkspace"

export function findCheckpointRunCount(messages: readonly Record<string, unknown>[], messageTs?: number) {
	if (messageTs !== undefined) {
		const runCount = readNumber(messages.find((message) => message.ts === messageTs)?.checkpointRunCount)
		if (runCount !== undefined) return runCount
	}
	for (let index = messages.length - 1; index >= 0; index--) {
		const runCount = readNumber(messages[index].checkpointRunCount)
		if (runCount !== undefined) return runCount
	}
	return undefined
}

export function findCheckpointMessage(messages: readonly Record<string, unknown>[], checkpointRunCount: number, messageTs?: number) {
	if (messageTs !== undefined) {
		const target = messages.find((message) => message.ts === messageTs)
		if (readNumber(target?.checkpointRunCount) === checkpointRunCount) return target
	}
	for (let index = messages.length - 1; index >= 0; index--) if (readNumber(messages[index].checkpointRunCount) === checkpointRunCount) return messages[index]
	return undefined
}

export function resolveCheckpointRestoreScope(value: unknown) {
	const scope: CheckpointRestoreScope = value === "task" || value === "workspace" ? value : "taskAndWorkspace"
	return { scope, restore: { messages: scope === "task" || scope === "taskAndWorkspace", workspace: scope === "workspace" || scope === "taskAndWorkspace" } }
}

function readNumber(value: unknown) { const number = Number(value); return Number.isFinite(number) ? number : undefined }

export function createCheckpointDiffDescription(input: {
	checkpointRunCount: number
	sessionId: string
	workspaceRoot: string
	createdAt?: number
	trackedChanges: readonly Record<string, unknown>[]
}) {
	const createdAtText = input.createdAt ? new Date(input.createdAt).toLocaleString() : ""
	const text = [
		`Checkpoint compare requested for SDK checkpoint #${input.checkpointRunCount}.`,
		input.sessionId ? `Session: ${input.sessionId}` : "",
		input.workspaceRoot ? `Workspace: ${input.workspaceRoot}` : "",
		createdAtText ? `Created: ${createdAtText}` : "",
		input.trackedChanges.length ? `Tracked edit snapshots: ${input.trackedChanges.length}` : "",
		"The current SDK runtime exposes checkpoint restore metadata, but not a first-class checkpoint diff stream. Use the transcript change cards or Review controls for file-level snapshots.",
	].filter(Boolean).join("\n")
	return {
		success: true,
		supported: true,
		checkpointRunCount: input.checkpointRunCount,
		sessionId: input.sessionId,
		workspaceRoot: input.workspaceRoot,
		comments: [{ type: "sdk_checkpoint_limitation", message: "Checkpoint diff stream is unavailable from the current SDK runtime; Visual Studio links the compare request to stored edit snapshots.", trackedChanges: input.trackedChanges }],
		trackedChanges: input.trackedChanges,
		text,
	}
}
