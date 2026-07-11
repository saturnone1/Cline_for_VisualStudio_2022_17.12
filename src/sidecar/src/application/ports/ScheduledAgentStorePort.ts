export interface ScheduledAgentStorePort {
	listSpecs(workspaceRoot: string): Array<Record<string, unknown>>
	saveSpec(workspaceRoot: string, request: Record<string, unknown>): Record<string, unknown>
	deleteSpec(workspaceRoot: string, specId: string): boolean
	listRuns(): Array<Record<string, unknown>>
	appendRun(run: Record<string, unknown>): Record<string, unknown>
	specSource(workspaceRoot: string): string
}
