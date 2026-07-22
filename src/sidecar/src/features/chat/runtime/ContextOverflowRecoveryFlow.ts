import type { SendUserMessageInput } from "../sendMessage/SendUserMessageFlow"
import type { SendMessageCommand } from "../sendMessage/SendMessageCommand"
import { isContextOverflowError } from "./ContextOverflowError"

type Callbacks = Readonly<{
	compact: (requestId: string, transcriptText: string) => Promise<string | undefined>
	nextGeneration: () => number
	transitionStarting: () => void
	showRetrying: () => void
	broadcast: () => Promise<void>
	normalizeImages: (images: string[]) => Promise<readonly string[]>
	send: (sessionId: string, command: SendMessageCommand, textLength: number) => Promise<unknown>
	resultSessionId: (result: unknown, fallback: string) => string
	complete: (result: unknown, sessionId: string, generation: number) => Promise<void>
	recover: (sessionId: string, generation: number, error: unknown) => Promise<void>
	log: (event: string, details: Record<string, unknown>) => void
}>

export class ContextOverflowRecoveryFlow {
	constructor(private readonly callbacks: Callbacks) {}

	async execute(input: SendUserMessageInput, failedGeneration: number, error: unknown) {
		if (!isContextOverflowError(error)) return false
		this.callbacks.log("contextOverflowRecoveryStarted", {
			sessionId: input.activeSessionId || input.selectedSessionId,
			failedGeneration,
			error: stringify(error),
		})
		const replacementSessionId = await this.callbacks.compact(`${input.requestId}:overflow-recovery`, input.transcriptText)
		if (!replacementSessionId) return false

		const generation = this.callbacks.nextGeneration()
		this.callbacks.transitionStarting()
		this.callbacks.showRetrying()
		await this.callbacks.broadcast()
		try {
			const result = await this.callbacks.send(replacementSessionId, {
				sessionId: replacementSessionId,
				prompt: input.prompt,
				mode: input.mode,
				userImages: await this.callbacks.normalizeImages(input.images),
				userFiles: input.files,
			}, input.transcriptText.length)
			await this.callbacks.complete(result, this.callbacks.resultSessionId(result, replacementSessionId), generation)
		} catch (retryError) {
			await this.callbacks.recover(replacementSessionId, generation, retryError)
		}
		return true
	}
}

function stringify(value: unknown) {
	return value instanceof Error ? value.message : String(value)
}
