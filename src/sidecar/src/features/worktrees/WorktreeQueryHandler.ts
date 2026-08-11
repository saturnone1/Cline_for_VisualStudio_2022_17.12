import type { InteractionLoggerPort } from "../../application/ports/InteractionLoggerPort"
import type { WorktreeOperationsPort } from "../../application/ports/WorktreeOperationsPort"
import { parseGitWorktreePorcelain, uniqueSortedLines } from "./WorktreePolicy"

export class WorktreeQueryHandler {
	constructor(private readonly operations: WorktreeOperationsPort, private readonly logger: InteractionLoggerPort) {}

	runGit(args: readonly string[], cwd: string) { return this.operations.runGit(args, cwd) }

	async resolveGitRoot(workspaceRoot = "") {
		const root = workspaceRoot || await this.getPrimaryWorkspaceRoot()
		if (!root || !(await this.operations.pathExists(root))) return { workspaceRoot: root, gitRoot: "", error: "No workspace root is available.", errorKind: "workspace_missing" }
		if (!(await this.operations.runGit(["--version"], this.operations.currentDirectory)).success) return { workspaceRoot: root, gitRoot: "", error: "Git is not available on PATH.", errorKind: "git_missing" }
		const result = await this.operations.runGit(["rev-parse", "--show-toplevel"], root)
		return result.success
			? { workspaceRoot: root, gitRoot: result.stdout.trim(), error: "", errorKind: "" }
			: { workspaceRoot: root, gitRoot: "", error: result.stderr || "Workspace is not a git repository.", errorKind: "repo_missing" }
	}

	async listWorktrees(requestedWorkspaceRoot = "") {
		const { workspaceRoot, gitRoot, error, errorKind } = await this.resolveGitRoot(requestedWorkspaceRoot)
		if (!gitRoot) {
			this.logger.log("sidecar", "worktreeListFailed", { errorKind, error })
			return { worktrees: [], items: [], isGitRepo: false, isMultiRoot: false, isSubfolder: false, gitRootPath: "", error, errorKind }
		}
		const result = await this.operations.runGit(["worktree", "list", "--porcelain"], gitRoot)
		if (!result.success) {
			this.logger.log("sidecar", "worktreeListFailed", { errorKind: "worktree_list_failed", gitRoot, stderr: result.stderr.slice(0, 1000) })
			return { worktrees: [], items: [], isGitRepo: true, isMultiRoot: false, isSubfolder: !this.operations.samePath(gitRoot, workspaceRoot), gitRootPath: gitRoot, error: result.stderr || "Failed to list git worktrees.", errorKind: "worktree_list_failed" }
		}
		const current = await this.resolveGitRoot(requestedWorkspaceRoot || await this.getPrimaryWorkspaceRoot())
		const currentRoot = current.gitRoot || gitRoot
		const worktrees = await Promise.all(parseGitWorktreePorcelain(result.stdout).map(async (item) => ({ ...item, ...(await this.getStatus(readString(item.path))), isCurrent: this.operations.samePath(readString(item.path), currentRoot) })))
		this.logger.log("sidecar", "worktreeListSucceeded", { gitRoot, count: worktrees.length })
		return { worktrees, items: worktrees, isGitRepo: true, isMultiRoot: false, isSubfolder: !this.operations.samePath(gitRoot, workspaceRoot), gitRootPath: gitRoot, error: "", errorKind: "" }
	}

	async getStatus(worktreePath: string) {
		if (!worktreePath || !(await this.operations.pathExists(worktreePath))) return { dirty: false, statusSummary: "missing", statusEntries: [], conflictCount: 0 }
		const status = await this.operations.runGit(["status", "--porcelain"], worktreePath)
		if (!status.success) return { dirty: false, statusSummary: status.stderr || "status unavailable", statusEntries: [], conflictCount: 0 }
		const lines = status.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
		if (!lines.length) return { dirty: false, statusSummary: "clean", statusEntries: [], conflictCount: 0 }
		const staged = lines.filter((line) => line[0] && line[0] !== "?" && line[0] !== " ").length
		const unstaged = lines.filter((line) => line[1] && line[1] !== " ").length
		const untracked = lines.filter((line) => line.startsWith("??")).length
		const conflicted = lines.filter((line) => /^([ADU]{2}|DD|AA|DU|UD|UA|AU)$/.test(line.slice(0, 2))).length
		const parts = [`${lines.length} change${lines.length === 1 ? "" : "s"}`, staged ? `${staged} staged` : "", unstaged ? `${unstaged} unstaged` : "", untracked ? `${untracked} untracked` : "", conflicted ? `${conflicted} conflict${conflicted === 1 ? "" : "s"}` : ""].filter(Boolean)
		return { dirty: true, statusSummary: parts.join(", "), statusEntries: lines.slice(0, 50).map((line) => ({ code: line.slice(0, 2), path: line.slice(3).trim() || line })), conflictCount: conflicted }
	}

	async getDefaults(requestedWorkspaceRoot = "") {
		const { workspaceRoot, gitRoot } = await this.resolveGitRoot(requestedWorkspaceRoot)
		const root = gitRoot || workspaceRoot || this.operations.currentDirectory
		const branchResult = await this.operations.runGit(["branch", "--show-current"], root)
		const baseBranch = branchResult.success ? branchResult.stdout.trim() : ""
		const branches = await this.localBranches(root)
		const remoteResult = await this.operations.runGit(["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"], root)
		const baseBranches = remoteResult.success ? uniqueSortedLines(remoteResult.stdout).filter((branch) => !/\/HEAD$/.test(branch)) : branches
		const rootName = this.operations.baseName(root.replace(/[\\/]+$/, "")) || "worktree"
		const suggestedPath = this.operations.joinPath(this.operations.dirName(root), `${rootName}-worktree`)
		return { branch: "", baseBranch, currentBranch: baseBranch, branches, baseBranches, cwd: root, suggestedBranch: `feature/${rootName}-task`, suggestedPath, recommendedPath: suggestedPath }
	}

	async getIncludeStatus(requestedWorkspaceRoot = "") {
		const { workspaceRoot, gitRoot } = await this.resolveGitRoot(requestedWorkspaceRoot)
		const root = gitRoot || workspaceRoot
		const includePath = root ? this.operations.joinPath(root, ".worktreeinclude") : ""
		const gitignorePath = root ? this.operations.joinPath(root, ".gitignore") : ""
		const [included, hasGitignore] = await Promise.all([this.operations.pathExists(includePath), this.operations.pathExists(gitignorePath)])
		return { enabled: !!root, included, exists: included, hasGitignore, gitignoreContent: hasGitignore ? await this.operations.readTextFile(gitignorePath) : "" }
	}

	async createInclude(content: string, requestedWorkspaceRoot = "") {
		const { workspaceRoot, gitRoot } = await this.resolveGitRoot(requestedWorkspaceRoot)
		const root = gitRoot || workspaceRoot
		if (!root) return { success: false, message: "No workspace root is available to create .worktreeinclude." }
		const targetPath = this.operations.joinPath(root, ".worktreeinclude")
		await this.operations.writeTextFile(targetPath, content)
		return { success: true, message: ".worktreeinclude created successfully.", path: targetPath }
	}

	private async getPrimaryWorkspaceRoot() { const roots = await this.operations.getWorkspacePaths().catch(() => []); return roots[0] || this.operations.currentDirectory }
	private async localBranches(root: string) { const result = await this.operations.runGit(["branch", "--format=%(refname:short)"], root); return result.success ? uniqueSortedLines(result.stdout) : [] }
}

function readString(value: unknown) { return typeof value === "string" ? value : "" }
