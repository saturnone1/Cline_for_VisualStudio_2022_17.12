import type { SendMessageCommand } from "../sendMessage/SendMessageCommand"

type Callbacks = Readonly<{
	isRuntimeAvailable: () => boolean
	activeSessionId: () => string
	selectedSessionId: () => string
	language: () => "en" | "ko"
	mode: () => "plan" | "act"
	addError: (text: string) => void
	transitionStarting: () => void
	startLatency: (requestId: string, sessionId: string, textLength: number) => void
	showProgress: (text: string) => void
	persist: () => void
	broadcast: () => Promise<void>
	nextGeneration: () => number
	currentGeneration: () => number
	send: (sessionId: string, command: SendMessageCommand, textLength: number) => Promise<unknown>
	resultSessionId: (result: unknown, fallback: string) => string
	complete: (result: unknown, sessionId: string, generation: number) => Promise<void>
	recover: (sessionId: string, generation: number, error: unknown) => Promise<void>
	log: (event: string, details: Record<string, unknown>) => void
}>

export class CompactSessionFlow {
	constructor(private readonly callbacks: Callbacks) {}

	async execute(requestId: string) {
		if (!this.callbacks.isRuntimeAvailable()) throw new Error("LIG VS SDK runtime is not attached.")
		const sessionId = this.callbacks.activeSessionId() || this.callbacks.selectedSessionId(), language = this.callbacks.language()
		if (!sessionId) { this.callbacks.addError(language === "en" ? "No active session to compact." : "압축할 활성 세션이 없습니다."); await this.callbacks.broadcast(); return }
		const prompt = language === "en" ? "Internal maintenance request: compact the current conversation context for future turns. Preserve the user's goals, important decisions, file paths, errors, pending tasks, and current state. Do not treat this as a user feature request." : "내부 유지보수 요청: 이후 대화를 위해 현재 대화 컨텍스트를 압축해 주세요. 사용자의 목표, 중요한 결정, 파일 경로, 오류, 남은 작업, 현재 상태를 보존하세요. 이것을 사용자의 일반 기능 요청으로 처리하지 마세요."
		this.callbacks.transitionStarting()
		this.callbacks.startLatency(requestId, sessionId, prompt.length)
		this.callbacks.showProgress(language === "en" ? "Compacting context..." : "컨텍스트 압축 중입니다.")
		this.callbacks.persist()
		await this.callbacks.broadcast()
		const command: SendMessageCommand = { sessionId, prompt, mode: this.callbacks.mode() }
		const generation = this.callbacks.nextGeneration()
		void Promise.resolve()
			.then(() => this.callbacks.send(sessionId, command, prompt.length))
			.then((result) => this.callbacks.complete(result, this.callbacks.resultSessionId(result, sessionId), generation))
			.catch(async (error) => {
				const currentRunGeneration = this.callbacks.currentGeneration()
				if (generation !== currentRunGeneration) { this.callbacks.log("ignoredSupersededSdkError", { source: "compact", sessionId, runGeneration: generation, currentRunGeneration, error: stringify(error) }); return }
				await this.callbacks.recover(sessionId, generation, error)
			})
	}
}

function stringify(value: unknown) { return value instanceof Error ? value.message : String(value) }
