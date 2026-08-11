import type { StartTaskCommand } from "../startTask/StartTaskCommand"

type Callbacks = Readonly<{
	isRuntimeAvailable: () => boolean
	buildConfig: (cwd: string, sessionId: string) => Promise<Readonly<Record<string, unknown>>>
	toolPolicies: () => Readonly<Record<string, unknown>>
	markSend: (sessionId: string) => void
	nextGeneration: () => number
	currentGeneration: () => number
	start: (command: StartTaskCommand) => Promise<unknown>
	markSettingsRevisionActive: () => void
	complete: (result: unknown, sessionId: string, source: string, generation: number) => Promise<void>
	recover: (sessionId: string, source: string, generation: number, error: unknown) => Promise<void>
	log: (event: string, details: Record<string, unknown>) => void
}>

export class LaunchAgentSessionFlow {
	constructor(private readonly callbacks: Callbacks) {}

	async execute(params: StartTaskCommand, cwd: string, sessionId: string, source: string) {
		if (!this.callbacks.isRuntimeAvailable()) return
		let generation = 0
		try {
			const config = await this.callbacks.buildConfig(cwd, sessionId)
			this.callbacks.markSend(sessionId)
			generation = this.callbacks.nextGeneration()
			const result = await this.callbacks.start({ ...params, config, toolPolicies: this.callbacks.toolPolicies() })
			this.callbacks.markSettingsRevisionActive()
			await this.callbacks.complete(result, sessionId, source, generation)
		} catch (error) {
			const currentRunGeneration = this.callbacks.currentGeneration()
			if (generation && generation !== currentRunGeneration) {
				this.callbacks.log("ignoredSupersededSdkError", { source, sessionId, runGeneration: generation, currentRunGeneration, error: stringify(error) })
				return
			}
			await this.callbacks.recover(sessionId, source, generation, error)
		}
	}
}

function stringify(value: unknown) { return value instanceof Error ? value.message : String(value) }
