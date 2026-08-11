import type { InteractionLoggerPort } from "../../application/ports/InteractionLoggerPort"
import type { WorktreeOperationsPort } from "../../application/ports/WorktreeOperationsPort"
import { classifyWorktreeGitError, normalizeMergeRecoveryAction } from "./WorktreePolicy"
import type { WorktreeQueryHandler } from "./WorktreeQueryHandler"

export type CreateWorktreeRequest = Readonly<{ path: string; branch: string; branchName: string; baseBranch: string; createNewBranch: boolean }>
export type SwitchWorktreeRequest = Readonly<{ path: string; solutionPath: string; newWindow: boolean }>
export type DeleteWorktreeRequest = Readonly<{ path: string; force: boolean; deleteBranch: boolean; branchName: string }>
export type MergeWorktreeRequest = Readonly<{ worktreePath: string; path: string; targetBranch: string; deleteAfterMerge: boolean }>
export type RecoverWorktreeRequest = Readonly<{ action: string; value: string; targetWorktreePath: string; workspacePath: string; path: string }>

export class WorktreeMutationHandler {
	constructor(private readonly operations: WorktreeOperationsPort, private readonly queries: WorktreeQueryHandler, private readonly logger: InteractionLoggerPort) {}

	async create(request: CreateWorktreeRequest, workspaceRoot: string) {
		const { gitRoot, error } = await this.queries.resolveGitRoot(workspaceRoot)
		if (!gitRoot) return this.failed("worktreeCreateFailed", { reason: "no_git_root", error }, error || "Worktrees require a git repository.")
		const rawPath = getString(request, "path")
		const branch = getString(request, "branch") || getString(request, "branchName")
		if (!rawPath || !branch) return this.failed("worktreeCreateFailed", { reason: "missing_path_or_branch", gitRoot }, "Both a worktree folder path and branch name are required.")
		const targetPath = this.operations.isAbsolutePath(rawPath) ? this.operations.resolvePath(rawPath) : this.operations.resolvePath(gitRoot, rawPath)
		const baseBranch = getString(request, "baseBranch") || (await this.queries.getDefaults(workspaceRoot)).baseBranch || "HEAD"
		this.logger.log("sidecar", "worktreeCreateStarted", { gitRoot, targetPath, branch, baseBranch, createNewBranch: request.createNewBranch !== false })
		if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith("-") || branch.includes("..") || branch.endsWith("/")) return this.failed("worktreeCreateFailed", { reason: "invalid_branch", branch }, `Invalid branch name: ${branch}`)
		if (await this.operations.pathExists(targetPath)) return this.failed("worktreeCreateFailed", { reason: "target_exists", targetPath }, `Worktree folder already exists: ${targetPath}`)
		const existingList = await this.queries.listWorktrees(workspaceRoot)
		if (existingList.worktrees.some((item) => this.operations.samePath(getString(item, "path"), targetPath))) return this.failed("worktreeCreateFailed", { reason: "registered_target_exists", targetPath }, `A git worktree is already registered at ${targetPath}`)
		if (this.operations.isPathInside(targetPath, gitRoot)) return this.failed("worktreeCreateFailed", { reason: "inside_repo", targetPath, gitRoot }, "Create the worktree outside the current repository folder.")
		const parent = existingList.worktrees.find((item) => { const value = getString(item, "path"); return value && this.operations.isPathInside(targetPath, value) })
		if (parent) return this.failed("worktreeCreateFailed", { reason: "inside_existing_worktree", targetPath, parentWorktree: getString(parent, "path") }, `Create the worktree outside existing worktree folders. Parent worktree: ${getString(parent, "path")}`)
		const branchExists = (await this.operations.runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], gitRoot)).success
		if (request.createNewBranch !== false && branchExists) return this.failed("worktreeCreateFailed", { reason: "branch_exists", branch }, `Branch already exists: ${branch}. Choose existing-branch mode or enter a new branch name.`)
		if (request.createNewBranch === false && !branchExists) return this.failed("worktreeCreateFailed", { reason: "branch_missing", branch }, `Branch does not exist: ${branch}. Choose new-branch mode or create the branch first.`)
		const args = ["worktree", "add", ...(request.createNewBranch !== false ? ["-b", branch] : ["--checkout"]), targetPath, request.createNewBranch === false ? branch : baseBranch]
		const result = await this.operations.runGit(args, gitRoot)
		if (!result.success) return this.failed("worktreeCreateFailed", { reason: "git_failed", stderr: truncate(result.stderr) }, classifyWorktreeGitError(result.stderr, "create"))
		await this.copyIncludeFiles(gitRoot, targetPath)
		const list = await this.queries.listWorktrees(workspaceRoot)
		const worktree = list.worktrees.find((item) => this.operations.samePath(getString(item, "path"), targetPath))
		this.logger.log("sidecar", "worktreeCreateSucceeded", { targetPath, branch, baseBranch })
		return { success: true, message: `Worktree created for ${branch} at ${targetPath}.`, worktree, worktrees: list.worktrees }
	}

	async switch(request: SwitchWorktreeRequest) {
		const requestedPath = getString(request, "path")
		if (!requestedPath) return this.failed("worktreeSwitchFailed", { reason: "missing_path" }, "Worktree path is required.")
		const targetPath = this.operations.resolvePath(requestedPath)
		if (!(await this.operations.pathExists(targetPath))) return this.failed("worktreeSwitchFailed", { reason: "missing_folder", targetPath }, `Worktree folder does not exist: ${targetPath}`)
		const candidates = this.operations.findSolutions(targetPath)
		if (candidates.length > 1 && !getString(request, "solutionPath")) return this.failed("worktreeSwitchNeedsSolutionChoice", { targetPath, count: candidates.length }, "Multiple .sln files were found. Choose a solution to open.", { path: targetPath, solutionCandidates: candidates })
		const requestedSolution = getString(request, "solutionPath")
		const solution = requestedSolution && candidates.some((candidate) => this.operations.samePath(candidate, requestedSolution)) ? requestedSolution : candidates[0] || ""
		const newWindow = request.newWindow === true
		if (!solution) {
			this.logger.log("sidecar", "worktreeSwitchFolderFallbackStarted", { targetPath, newWindow })
			const result = asRecord(await this.operations.openFolder(targetPath, newWindow))
			return { success: result.success !== false, message: getString(result, "message") || (newWindow ? `Folder-only worktree opened in a new Visual Studio window: ${targetPath}` : `Folder-only worktree opened in this Visual Studio window: ${targetPath}`), path: targetPath, workspacePath: targetPath, folderOnly: true, folderOpenFallback: true, solutionCandidates: [] }
		}
		this.logger.log("sidecar", "worktreeSwitchStarted", { targetPath, solution, newWindow })
		const result = asRecord(await this.operations.openSolution(solution, newWindow))
		if (result.success === false) return this.failed("worktreeSwitchFailed", { reason: "host_failed", targetPath, solution, message: getString(result, "message") }, getString(result, "message") || "Visual Studio could not open the selected worktree solution.", { path: targetPath, solutionPath: solution, solutionCandidates: candidates })
		this.logger.log("sidecar", "worktreeSwitchSucceeded", { targetPath, solution, newWindow })
		return { success: true, message: newWindow ? `Worktree opened in a new Visual Studio window: ${solution}` : `Worktree opened in this Visual Studio window: ${solution}`, path: targetPath, workspacePath: targetPath, solutionPath: solution, solutionCandidates: candidates }
	}

	async delete(request: DeleteWorktreeRequest, workspaceRoot: string) {
		const { gitRoot, error } = await this.queries.resolveGitRoot(workspaceRoot)
		if (!gitRoot) return this.failed("worktreeDeleteFailed", { reason: "no_git_root", error }, error || "Worktrees require a git repository.")
		const requestedPath = getString(request, "path")
		if (!requestedPath) return this.failed("worktreeDeleteFailed", { reason: "missing_path", gitRoot }, "Worktree path is required.")
		const targetPath = this.operations.resolvePath(requestedPath)
		const force = request.force === true
		const branchName = getString(request, "branchName")
		this.logger.log("sidecar", "worktreeDeleteStarted", { gitRoot, targetPath, force, deleteBranch: request.deleteBranch === true, branchName })
		const status = await this.queries.getStatus(targetPath)
		if (!force && status.dirty) return this.failed("worktreeDeleteFailed", { reason: "dirty", targetPath, statusSummary: status.statusSummary }, `Cannot delete a worktree with uncommitted changes (${status.statusSummary}). Commit/stash changes or retry with force.`, { dirty: true, statusSummary: status.statusSummary })
		const removed = await this.operations.runGit(["worktree", "remove", ...(force ? ["--force"] : []), targetPath], gitRoot)
		if (!removed.success) return this.failed("worktreeDeleteFailed", { reason: "git_failed", targetPath, stderr: truncate(removed.stderr) }, classifyWorktreeGitError(removed.stderr, "delete"))
		if (request.deleteBranch === true && branchName) {
			const deleted = await this.operations.runGit(["branch", "-D", branchName], gitRoot)
			if (!deleted.success) { this.logger.log("sidecar", "worktreeDeleteBranchFailed", { targetPath, branchName, stderr: truncate(deleted.stderr) }); return { success: true, warning: deleted.stderr || branchName, message: `Worktree deleted, but branch deletion failed: ${deleted.stderr || branchName}` } }
		}
		this.logger.log("sidecar", "worktreeDeleteSucceeded", { targetPath, branchName: branchName || undefined })
		return { success: true, message: `Worktree deleted: ${targetPath}.`, ...(await this.queries.listWorktrees(workspaceRoot)) }
	}

	async merge(request: MergeWorktreeRequest, workspaceRoot: string) {
		const { gitRoot, error } = await this.queries.resolveGitRoot(workspaceRoot)
		if (!gitRoot) return { success: false, message: error || "Worktrees require a git repository.", hasConflicts: false, conflictingFiles: [] }
		const requestedPath = getString(request, "worktreePath") || getString(request, "path")
		if (!requestedPath) return { success: false, message: "Worktree path is required.", hasConflicts: false, conflictingFiles: [] }
		const worktreePath = this.operations.resolvePath(requestedPath)
		const targetBranch = getString(request, "targetBranch") || (await this.queries.getDefaults(workspaceRoot)).baseBranch || "main"
		const sourceBranch = await this.branchFor(worktreePath, workspaceRoot)
		this.logger.log("sidecar", "worktreeMergeStarted", { sourceWorktreePath: worktreePath, sourceBranch, targetWorktreePath: gitRoot, targetBranch, deleteAfterMerge: request.deleteAfterMerge === true })
		if (!sourceBranch) return { success: false, message: "Cannot merge a detached or unknown worktree branch.", hasConflicts: false, conflictingFiles: [] }
		const sourceStatus = await this.queries.getStatus(worktreePath)
		if (sourceStatus.dirty) return { success: false, message: `Cannot merge while the source worktree has uncommitted changes (${sourceStatus.statusSummary}).`, hasConflicts: false, conflictingFiles: [], sourceBranch, targetBranch }
		const rootStatus = await this.queries.getStatus(gitRoot)
		if (rootStatus.dirty) return { success: false, message: `Cannot merge while the target worktree has uncommitted changes (${rootStatus.statusSummary}).`, hasConflicts: false, conflictingFiles: [], sourceBranch, targetBranch }
		const checkout = await this.operations.runGit(["checkout", targetBranch], gitRoot)
		if (!checkout.success) return { success: false, message: classifyWorktreeGitError(checkout.stderr || `Failed to checkout ${targetBranch}.`, "merge"), hasConflicts: false, conflictingFiles: [], sourceBranch, targetBranch, sourceWorktreePath: worktreePath, targetWorktreePath: gitRoot }
		const merged = await this.operations.runGit(["merge", "--no-ff", sourceBranch], gitRoot)
		if (!merged.success) {
			const conflicts = await this.conflicts(gitRoot)
			return { success: false, message: merged.stderr || "Merge failed.", hasConflicts: conflicts.length > 0, conflictingFiles: conflicts, recoveryState: conflicts.length ? "merge_conflict" : "merge_failed", recoveryCommands: ["git status --short", "git diff --name-only --diff-filter=U", "git merge --abort", `git checkout ${targetBranch}`], recoveryPrompt: `Merge conflict while merging ${sourceBranch} from ${worktreePath} into ${targetBranch} at ${gitRoot}. Conflicts: ${conflicts.join(", ") || "(unknown)"}.`, sourceBranch, targetBranch, sourceWorktreePath: worktreePath, targetWorktreePath: gitRoot }
		}
		let warning = ""
		if (request.deleteAfterMerge === true) { const deleted = asRecord(await this.delete({ path: worktreePath, force: false, deleteBranch: false, branchName: "" }, workspaceRoot)); if (deleted.success === false) warning = getString(deleted, "message") || "Merge succeeded, but the source worktree could not be deleted." }
		this.logger.log("sidecar", "worktreeMergeSucceeded", { sourceBranch, targetBranch, warning: warning || undefined })
		return { success: true, message: warning ? `Merged ${sourceBranch} into ${targetBranch}. ${warning}` : `Merged ${sourceBranch} into ${targetBranch}.`, hasConflicts: false, conflictingFiles: [], sourceBranch, targetBranch, sourceWorktreePath: worktreePath, targetWorktreePath: gitRoot, warning }
	}

	async recover(request: RecoverWorktreeRequest) {
		const action = normalizeMergeRecoveryAction(getString(request, "action") || getString(request, "value") || "status")
		const requestedPath = getString(request, "targetWorktreePath") || getString(request, "workspacePath") || getString(request, "path")
		const { gitRoot, error } = await this.queries.resolveGitRoot(requestedPath)
		if (!gitRoot) return { success: false, action, message: error || "Worktrees require a git repository.", conflictingFiles: [] }
		if (action === "abort" || action === "continue") { const result = await this.operations.runGit(["merge", `--${action}`], gitRoot); return { success: result.success, action, message: result.success ? `Merge ${action === "abort" ? "aborted" : "continued"}.` : result.stderr || `Failed to ${action} merge.`, conflictingFiles: await this.conflicts(gitRoot), targetWorktreePath: gitRoot } }
		const status = await this.queries.getStatus(gitRoot)
		return { success: true, action: "status", message: status.statusSummary || "Merge status loaded.", statusSummary: status.statusSummary, statusEntries: status.statusEntries, conflictingFiles: await this.conflicts(gitRoot), targetWorktreePath: gitRoot }
	}

	private async copyIncludeFiles(gitRoot: string, targetPath: string) {
		const includePath = this.operations.joinPath(gitRoot, ".worktreeinclude")
		if (!(await this.operations.pathExists(includePath))) return
		for (const entry of (await this.operations.readTextFile(includePath)).split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"))) {
			const source = this.operations.resolvePath(gitRoot, entry), destination = this.operations.resolvePath(targetPath, entry)
			if (this.operations.isPathInside(source, gitRoot) && this.operations.isPathInside(destination, targetPath) && await this.operations.pathExists(source)) await this.operations.copyPath(source, destination)
		}
	}
	private async branchFor(path: string, workspaceRoot: string) { const list = await this.queries.listWorktrees(workspaceRoot); return getString(list.worktrees.find((item) => this.operations.samePath(getString(item, "path"), path)), "branch") }
	private async conflicts(root: string) { const result = await this.operations.runGit(["diff", "--name-only", "--diff-filter=U"], root); return result.success ? result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [] }
	private failed(event: string, details: Record<string, unknown>, message: string, extra: Record<string, unknown> = {}) { this.logger.log("sidecar", event, details); return { success: false, message, ...extra } }
}

function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function getString(value: unknown, key: string): string { const record = asRecord(value); return typeof record[key] === "string" ? record[key] as string : "" }
function truncate(value: string) { return value.slice(0, 1000) }
