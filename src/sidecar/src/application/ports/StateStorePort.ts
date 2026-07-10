export interface StateStorePort {
	load(): Record<string, unknown> | null
	save(snapshot: Record<string, unknown>): void
	clear(): void
}
