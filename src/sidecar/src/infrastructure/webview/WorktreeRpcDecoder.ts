import type { WorktreeCommand } from "../../features/worktrees/WorktreeRpcHandler"

export function decodeWorktreeRpcCommand(key: string, message: unknown): WorktreeCommand | undefined {
	const request = asRecord(message)
	switch (key) {
		case "WorktreeService.listWorktrees": return { type: "list" }
		case "WorktreeService.getWorktreeDefaults": return { type: "defaults" }
		case "WorktreeService.getWorktreeIncludeStatus": return { type: "includeStatus" }
		case "WorktreeService.createWorktreeInclude": return { type: "createInclude", content: readString(request.content) }
		case "WorktreeService.createWorktree": return { type: "create", request: { path: readString(request.path), branch: readString(request.branch), branchName: readString(request.branchName), baseBranch: readString(request.baseBranch), createNewBranch: request.createNewBranch !== false } }
		case "WorktreeService.switchWorktree": return { type: "switch", request: { path: readString(request.path), solutionPath: readString(request.solutionPath), newWindow: request.newWindow === true } }
		case "WorktreeService.mergeWorktree": return { type: "merge", request: { worktreePath: readString(request.worktreePath), path: readString(request.path), targetBranch: readString(request.targetBranch), deleteAfterMerge: request.deleteAfterMerge === true } }
		case "WorktreeService.recoverMerge":
		case "WorktreeService.mergeRecovery": return { type: "recover", request: { action: readString(request.action), value: readString(request.value), targetWorktreePath: readString(request.targetWorktreePath), workspacePath: readString(request.workspacePath), path: readString(request.path) } }
		case "WorktreeService.deleteWorktree": return { type: "delete", request: { path: readString(request.path), force: request.force === true, deleteBranch: request.deleteBranch === true, branchName: readString(request.branchName) } }
		case "WorktreeService.trackWorktreeViewOpened": return { type: "trackOpened" }
		default: return undefined
	}
}

function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function readString(value: unknown) { return typeof value === "string" ? value : "" }
