export function parseGitWorktreePorcelain(output: string) {
	const worktrees: Array<Record<string, unknown>> = []
	let current: Record<string, unknown> | null = null
	const pushCurrent = () => {
		if (current && readString(current.path)) worktrees.push(current)
		current = null
	}
	for (const rawLine of output.split(/\r?\n/)) {
		const line = rawLine.trim()
		if (!line) { pushCurrent(); continue }
		const [key, ...rest] = line.split(" ")
		const value = rest.join(" ")
		if (key === "worktree") {
			pushCurrent()
			current = { path: value, branch: "", head: "", isBare: false, isDetached: false, isLocked: false, isPrunable: false, isCurrent: false }
			continue
		}
		if (!current) continue
		switch (key) {
			case "HEAD": current.head = value; break
			case "branch": current.branch = value.replace(/^refs\/heads\//, ""); break
			case "bare": current.isBare = true; break
			case "detached": current.isDetached = true; break
			case "locked": current.isLocked = true; current.lockReason = value; break
			case "prunable": current.isPrunable = true; current.prunableReason = value; break
		}
	}
	pushCurrent()
	return worktrees
}

export function uniqueSortedLines(output: string) {
	return Array.from(new Set(output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)))
		.sort((left, right) => left.localeCompare(right))
}

export function classifyWorktreeGitError(stderr: string, operation: "create" | "delete" | "merge") {
	const text = (stderr || "").trim()
	const lower = text.toLowerCase()
	if (!text) return operation === "create" ? "Failed to create worktree." : operation === "delete" ? "Failed to delete worktree." : "Failed to merge worktree."
	if (lower.includes("already exists")) return `Target path or branch already exists. ${text}`
	if (lower.includes("invalid reference") || lower.includes("not a valid branch") || lower.includes("not a valid object name")) return `The selected branch or base branch is invalid. ${text}`
	if (lower.includes("is already checked out")) return `The selected branch is already checked out in another worktree. ${text}`
	if (lower.includes("not a git repository")) return `This folder is not a git repository. ${text}`
	if (lower.includes("permission denied") || lower.includes("access is denied")) return `Git could not access the target path. ${text}`
	if (lower.includes("uncommitted changes") || lower.includes("local changes")) return `Uncommitted changes are blocking this worktree operation. ${text}`
	if (lower.includes("conflict") || lower.includes("automatic merge failed")) return `Merge conflict detected. ${text}`
	return text
}

export function normalizeMergeRecoveryAction(value: string) {
	const normalized = value.trim().toLowerCase()
	return normalized === "abort" || normalized === "continue" || normalized === "status" ? normalized : "status"
}

function readString(value: unknown) { return typeof value === "string" ? value : "" }
