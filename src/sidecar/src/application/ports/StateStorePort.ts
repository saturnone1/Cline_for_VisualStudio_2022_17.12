export interface StateStorePort {
	load(): Record<string, unknown> | null
	save(snapshot: Record<string, unknown>): void
	saveDeferred?(snapshot: Record<string, unknown>): Promise<void>
	invalidatePendingWrites?(): void
	clear(): void
}
