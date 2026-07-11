export type ScheduledAgentSpecInput = Readonly<{
	id: string
	specId: string
	name: string
	fileName: string
	description: string
	schedule: string
	cron: string
	prompt: string
	task: string
	text: string
	enabled?: boolean
}>

export interface ScheduledAgentStorePort {
	listSpecs(workspaceRoot: string): Array<Record<string, unknown>>
	saveSpec(workspaceRoot: string, request: ScheduledAgentSpecInput): Record<string, unknown>
	deleteSpec(workspaceRoot: string, specId: string): boolean
	listRuns(): Array<Record<string, unknown>>
	appendRun(run: Record<string, unknown>): Record<string, unknown>
	specSource(workspaceRoot: string): string
}
