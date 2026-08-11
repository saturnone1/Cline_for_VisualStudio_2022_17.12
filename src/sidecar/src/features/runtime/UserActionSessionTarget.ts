export function resolveUserActionSessionId(selectedSessionId: string, activeSessionId: string) {
	return selectedSessionId.trim() || activeSessionId.trim()
}
