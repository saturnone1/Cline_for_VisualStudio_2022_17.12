import type { SendMessageCommand } from "./SendMessageCommand"

export type SendUserMessageInput = Readonly<{ requestId: string; prompt: string; transcriptText: string; images: string[]; files: string[]; delivery?: "queue" | "steer"; mode: "plan" | "act"; activeSessionId: string; selectedSessionId: string }>
type Dependencies = Readonly<{
	interactions: Readonly<{ hasPending: () => boolean; clear: () => void }>
	newTask: Readonly<{ start: (input: SendUserMessageInput) => Promise<void> }>
	lifecycle: Readonly<{ startLatency: (requestId: string, sessionId: string, textLength: number) => void; transitionStarting: () => void; nextGeneration: () => number; currentGeneration: () => number }>
	projection: Readonly<{ addUserMessage: (text: string) => unknown; showPreparing: () => void; persist: () => void; publishPartial: (message: unknown) => void; broadcast: () => void }>
	attachments: Readonly<{ normalizeImages: (images: string[]) => Promise<readonly string[]> }>
	hooks: Readonly<{ onPrompt: (context: Record<string, unknown>) => void }>
	agent: Readonly<{ send: (sessionId: string, command: SendMessageCommand, textLength: number) => Promise<unknown>; resultSessionId: (result: unknown, fallback: string) => string; complete: (result: unknown, sessionId: string, generation: number) => Promise<void>; recover: (sessionId: string, generation: number, error: unknown) => Promise<void>; recoverContextOverflow: (input: SendUserMessageInput, generation: number, error: unknown) => Promise<boolean> }>
	log: (event: string, details: Record<string, unknown>) => void
}>

export class SendUserMessageFlow {
	constructor(private readonly dependencies: Dependencies) {}

	async execute(input: SendUserMessageInput) {
		if (!input.transcriptText.trim()) return
		const normalizedImages = await this.dependencies.attachments.normalizeImages(input.images)
		if (normalizedImages.length !== input.images.length) {
			throw new Error("One or more attached images could not be read. Reattach the image and try again.")
		}
		if (this.dependencies.interactions.hasPending()) {
			this.dependencies.log("sendAskResponse.stalePendingIgnored", { activeSessionId: input.activeSessionId, selectedSessionId: input.selectedSessionId })
			this.dependencies.interactions.clear()
		}
		const sessionId = input.activeSessionId || input.selectedSessionId
		if (!sessionId) {
			this.dependencies.log("sendAskResponse.startNewTask", { textLength: input.transcriptText.length })
			await this.dependencies.newTask.start(input)
			return
		}
		this.dependencies.lifecycle.startLatency(input.requestId, sessionId, input.transcriptText.length)
		this.dependencies.lifecycle.transitionStarting()
		const userMessage = this.dependencies.projection.addUserMessage(input.transcriptText)
		this.dependencies.projection.showPreparing()
		this.dependencies.projection.persist()
		this.dependencies.projection.publishPartial(userMessage)
		this.dependencies.projection.broadcast()
		const command: SendMessageCommand = { sessionId, prompt: input.prompt, mode: input.mode, userImages: normalizedImages, userFiles: input.files, delivery: input.delivery }
		this.dependencies.log("sendAskResponse.attachmentsPrepared", { imageCount: input.images.length, normalizedImageCount: normalizedImages.length, fileCount: input.files.length })
		this.dependencies.hooks.onPrompt({ prompt: input.prompt, sessionId, images: input.images, files: input.files })
		const generation = this.dependencies.lifecycle.nextGeneration()
		this.dependencies.agent.send(sessionId, command, input.transcriptText.length)
			.then((result) => this.dependencies.agent.complete(result, this.dependencies.agent.resultSessionId(result, sessionId), generation))
			.catch(async (error) => {
				const currentRunGeneration = this.dependencies.lifecycle.currentGeneration()
				if (generation !== currentRunGeneration) {
					this.dependencies.log("ignoredSupersededSdkError", { source: "send", sessionId, runGeneration: generation, currentRunGeneration, error: stringify(error) })
					return
				}
				if (await this.dependencies.agent.recoverContextOverflow(input, generation, error)) return
				await this.dependencies.agent.recover(sessionId, generation, error)
			})
	}
}

function stringify(value: unknown) { return value instanceof Error ? value.message : String(value) }
