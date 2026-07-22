export type TaskHistoryQuery = Readonly<{
	favoritesOnly: boolean
	searchQuery: string
	sortBy: string
	currentWorkspaceOnly: boolean
	cursor?: number
	pageSize?: number
}>

type Task = Record<string, unknown>

export function queryTaskHistory(tasks: readonly Task[], query: TaskHistoryQuery, currentWorkspace: string) {
	const workspace = normalizePath(currentWorkspace)
	const terms = normalizeSearch(query.searchQuery).split(/\s+/).filter(Boolean)
	const filtered = tasks.filter((task) => {
		if (query.favoritesOnly && task.isFavorited !== true) return false
		if (query.currentWorkspaceOnly && (!workspace || normalizePath(stringValue(task.cwdOnTaskInitialization)) !== workspace)) return false
		if (terms.length && !terms.every((term) => searchableTaskText(task).includes(term))) return false
		return true
	})

	return [...filtered].sort((left, right) => {
		switch (query.sortBy) {
			case "oldest": return numberValue(left.ts) - numberValue(right.ts)
			case "mostTokens": return totalTokens(right) - totalTokens(left)
			case "mostRelevant": return relevanceScore(right, terms) - relevanceScore(left, terms) || numberValue(right.ts) - numberValue(left.ts)
			default: return numberValue(right.ts) - numberValue(left.ts)
		}
	})
}

function relevanceScore(task: Task, terms: readonly string[]) {
	if (!terms.length) return 0
	const title = normalizeSearch([task.task, task.title].map(stringValue).join(" "))
	const all = searchableTaskText(task)
	return terms.reduce((score, term) => score + (title === term ? 8 : title.startsWith(term) ? 5 : title.includes(term) ? 3 : all.includes(term) ? 1 : 0), 0)
}

function searchableTaskText(task: Task) {
	return normalizeSearch([
		task.task,
		task.title,
		task.id,
		task.modelId,
		task.cwdOnTaskInitialization,
	].map(stringValue).join(" "))
}

function normalizeSearch(value: string) {
	return value.normalize("NFKC").toLocaleLowerCase().trim()
}

export function taskHistorySize(tasks: readonly Task[]) {
	return tasks.reduce((total, task) => total + Math.max(0, numberValue(task.size)), 0)
}

function totalTokens(task: Task) {
	return numberValue(task.tokensIn) + numberValue(task.tokensOut) + numberValue(task.cacheReads) + numberValue(task.cacheWrites)
}

function normalizePath(value: string) {
	return value.trim().replace(/[\\/]+$/, "").replace(/\\/g, "/").toLocaleLowerCase()
}

function stringValue(value: unknown) { return typeof value === "string" ? value : "" }
function numberValue(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : 0 }
