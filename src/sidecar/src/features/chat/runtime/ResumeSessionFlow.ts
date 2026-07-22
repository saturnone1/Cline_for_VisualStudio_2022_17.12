import type { SendMessageCommand } from "../sendMessage/SendMessageCommand"
import type { StartTaskCommand } from "../startTask/StartTaskCommand"

type PreparedTask = Readonly<{ title: string }>
type Callbacks = Readonly<{
	isRuntimeAvailable: () => boolean
	workspaceRoots: () => Promise<string[]>
	currentCwd: () => string
	prepareTask: (sessionId: string, prompt: string, cwd: string) => PreparedTask
	noteActivity: (reason: string) => void
	updateTask: () => void
	broadcast: () => Promise<void>
	runResumeHook: (context: Record<string, unknown>) => void
	buildInitialMessages: (prompt: string) => readonly unknown[]
	normalizeImages: (images: readonly string[]) => Promise<readonly string[]>
	buildConfig: (cwd: string) => Promise<Readonly<Record<string, unknown>>>
	toolPolicies: () => Readonly<Record<string, unknown>>
	start: (command: StartTaskCommand) => Promise<unknown>
	beginReplacement: (sourceSessionId: string) => void
	completeReplacement: (result: unknown) => void
	cancelReplacement: () => void
	markSettingsRevisionActive: () => void
	log: (event: string, details: Record<string, unknown>) => void
}>

export class ResumeSessionFlow {
	constructor(private readonly callbacks: Callbacks) {}

	async execute(sessionId: string, command: SendMessageCommand, textLength: number) {
		if (!this.callbacks.isRuntimeAvailable()) throw new Error("LIG VS SDK runtime is not attached.")
		const roots = await this.callbacks.workspaceRoots()
		const cwd = this.callbacks.currentCwd() || roots[0] || process.cwd()
		const prompt = command.prompt || "", userImages = command.userImages || [], userFiles = command.userFiles || []
		const task = this.callbacks.prepareTask(sessionId, prompt, cwd)
		this.callbacks.noteActivity("resume-session")
		this.callbacks.updateTask()
		await this.callbacks.broadcast()
		this.callbacks.log("sendAskResponse.resumeStartSession", { sessionId, textLength, cwd })
		this.callbacks.runResumeHook({ prompt, cwd, userImages, userFiles, sessionId })
		this.callbacks.beginReplacement(sessionId)
		try {
			const result = await this.callbacks.start({ prompt, cwd, userImages: await this.callbacks.normalizeImages(userImages), userFiles, interactive: true, initialMessages: this.callbacks.buildInitialMessages(prompt), sessionMetadata: task.title ? { title: task.title, ligVsResumed: true, ligVsResumedFrom: sessionId } : { ligVsResumed: true, ligVsResumedFrom: sessionId }, config: await this.callbacks.buildConfig(cwd), toolPolicies: this.callbacks.toolPolicies() })
			this.callbacks.completeReplacement(result)
			this.callbacks.markSettingsRevisionActive()
			return result
		} catch (error) {
			this.callbacks.cancelReplacement()
			throw error
		}
	}
}
