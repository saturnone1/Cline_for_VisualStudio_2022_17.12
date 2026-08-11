export function parseJsonObject<T extends object>(value?: string): T {
	if (!value) return {} as T
	try {
		const parsed: unknown = JSON.parse(value)
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as T) : ({} as T)
	} catch {
		return {} as T
	}
}
