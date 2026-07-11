import type { HookScript } from "../dto/HookContracts"

export type HookProcessResult = Readonly<{ exitCode: number; stdout: string; stderr: string; error?: string }>

export interface HookExecutionPort {
	execute(hook: HookScript, context: Record<string, unknown>): Promise<HookProcessResult>
}
