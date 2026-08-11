export type TaskHistoryItem = Record<string, unknown> & { id?: unknown }

export function upsertTaskHistoryItem(history: readonly TaskHistoryItem[], item: TaskHistoryItem) {
	const id = taskId(item)
	return [{ ...item }, ...history.filter((candidate) => taskId(candidate) !== id)]
}

export function rebindTaskHistoryId(history: readonly TaskHistoryItem[], previousId: string, sessionId: string) {
	if (!previousId || !sessionId || previousId === sessionId) return history.map((item) => ({ ...item }))
	return history.map((item) => taskId(item) === previousId ? { ...item, id: sessionId } : { ...item })
}

export function setTaskHistoryFavorite(history: readonly TaskHistoryItem[], id: string, isFavorited: boolean) {
	return history.map((item) => taskId(item) === id ? { ...item, isFavorited } : { ...item })
}

export function removeTaskHistoryItems(history: readonly TaskHistoryItem[], ids: ReadonlySet<string>) {
	return history.filter((item) => !ids.has(taskId(item))).map((item) => ({ ...item }))
}

function taskId(item: TaskHistoryItem) {
	return String(item.id || "")
}
