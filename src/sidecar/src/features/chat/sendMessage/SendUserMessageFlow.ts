import type { SendMessageCommand } from "./SendMessageCommand"

export type SendUserMessageInput = Readonly<{ requestId: string; prompt: string; transcriptText: string; images: string[]; files: string[]; delivery?: "queue" | "steer"; mode: "plan" | "act"; activeSessionId: string; selectedSessionId: string }>
type Callbacks = Readonly<{
	hasPendingApproval: () => boolean
	hasPendingQuestion: () => boolean
	clearPending: () => void
	startNewTask: (input: SendUserMessageInput) => Promise<void>
	startLatency: (requestId: string, sessionId: string, textLength: number) => void
	transitionStarting: () => void
	projectUserMessage: (text: string) => unknown
	showPreparing: () => void
	persist: () => void
	publishPartial: (message: unknown) => void
	broadcast: () => void
	normalizeImages: (images: string[]) => Promise<readonly string[]>
	runHook: (context: Record<string, unknown>) => void
	nextGeneration: () => number
	currentGeneration: () => number
	send: (sessionId: string, command: SendMessageCommand, textLength: number) => Promise<unknown>
	resultSessionId: (result: unknown, fallback: string) => string
	complete: (result: unknown, sessionId: string, generation: number) => Promise<void>
	recover: (sessionId: string, generation: number, error: unknown) => Promise<void>
	log: (event: string, details: Record<string, unknown>) => void
}>

export class SendUserMessageFlow {
	constructor(private readonly callbacks: Callbacks) {}

	async execute(input: SendUserMessageInput) {
		if (!input.transcriptText.trim()) return
		if (this.callbacks.hasPendingApproval() || this.callbacks.hasPendingQuestion()) {
			this.callbacks.log("sendAskResponse.stalePendingIgnored", { hasPendingApproval: this.callbacks.hasPendingApproval(), hasPendingQuestion: this.callbacks.hasPendingQuestion(), activeSessionId: input.activeSessionId, selectedSessionId: input.selectedSessionId })
			this.callbacks.clearPending()
		}
		const sessionId = input.activeSessionId || input.selectedSessionId
		if (!sessionId) {
			this.callbacks.log("sendAskResponse.startNewTask", { textLength: input.transcriptText.length })
			await this.callbacks.startNewTask(input)
			return
		}
		this.callbacks.startLatency(input.requestId, sessionId, input.transcriptText.length)
		this.callbacks.transitionStarting()
		const userMessage = this.callbacks.projectUserMessage(input.transcriptText)
		this.callbacks.showPreparing()
		this.callbacks.persist()
		this.callbacks.publishPartial(userMessage)
		this.callbacks.broadcast()
		const command: SendMessageCommand = { sessionId, prompt: input.prompt, mode: input.mode, userImages: await this.callbacks.normalizeImages(input.images), userFiles: input.files, delivery: input.delivery }
		this.callbacks.runHook({ prompt: input.prompt, sessionId, images: input.images, files: input.files })
		const generation = this.callbacks.nextGeneration()
		this.callbacks.send(sessionId, command, input.transcriptText.length)
			.then((result) => this.callbacks.complete(result, this.callbacks.resultSessionId(result, sessionId), generation))
			.catch(async (error) => {
				const currentRunGeneration = this.callbacks.currentGeneration()
				if (generation !== currentRunGeneration) {
					this.callbacks.log("ignoredSupersededSdkError", { source: "send", sessionId, runGeneration: generation, currentRunGeneration, error: stringify(error) })
					return
				}
				await this.callbacks.recover(sessionId, generation, error)
			})
	}
}

function stringify(value: unknown) { return value instanceof Error ? value.message : String(value) }
