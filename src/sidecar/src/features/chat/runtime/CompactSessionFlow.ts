import type { AgentCompactSessionRequest } from "../../../application/ports/AgentEnginePort"
import { resolveUserActionSessionId } from "../../runtime/UserActionSessionTarget"

type CompactionResult = Readonly<{ sessionId: string; messagesAfter: number; estimatedTokensAfter: number; summary: string }>
type Callbacks = Readonly<{
	isRuntimeAvailable: () => boolean
	activeSessionId: () => string
	selectedSessionId: () => string
	language: () => "en" | "ko"
	transitionStarting: () => void
	showProgress: (text: string) => void
	persist: () => void
	broadcast: () => Promise<void>
	buildRequest: (sourceSessionId: string, excludeTrailingUserText: string, signal?: AbortSignal) => Promise<AgentCompactSessionRequest>
	compact: (request: AgentCompactSessionRequest) => Promise<unknown>
	result: (result: unknown) => CompactionResult
	applySuccess: (sourceSessionId: string, result: CompactionResult, messagesBefore: number, messagesAfter: number) => Promise<void>
	cleanupSource: (sourceSessionId: string) => Promise<void>
	rollbackReplacement: (sourceSessionId: string, replacementSessionId: string) => Promise<void>
	applyFailure: (error: unknown) => Promise<void>
	messageCount: () => number
	log: (event: string, details: Record<string, unknown>) => void
}>

export class CompactSessionFlow {
	private inFlight = false

	constructor(private readonly callbacks: Callbacks) {}

	async execute(requestId: string, excludeTrailingUserText = "", signal?: AbortSignal): Promise<string | undefined> {
		if (this.inFlight) return undefined
		if (!this.callbacks.isRuntimeAvailable()) throw new Error("LIG VS SDK runtime is not attached.")
		const sourceSessionId = resolveUserActionSessionId(this.callbacks.selectedSessionId(), this.callbacks.activeSessionId())
		if (!sourceSessionId) {
			await this.callbacks.applyFailure(new Error(this.callbacks.language() === "en" ? "No active session to compact." : "압축할 활성 세션이 없습니다."))
			return undefined
		}

		this.inFlight = true
		const messagesBefore = this.callbacks.messageCount()
		this.callbacks.transitionStarting()
		this.callbacks.showProgress(this.callbacks.language() === "en" ? "Compacting context..." : "컨텍스트 압축 중입니다.")
		this.callbacks.persist()
		await this.callbacks.broadcast()
		let replacementSessionId = ""

		try {
			throwIfAborted(signal)
			const command = await this.callbacks.buildRequest(sourceSessionId, excludeTrailingUserText, signal)
			const result = await this.callbacks.compact(command)
			throwIfAborted(signal)
			const compacted = this.callbacks.result(result)
			const sessionId = compacted.sessionId
			if (!sessionId || sessionId === sourceSessionId) throw new Error("SDK did not create a replacement session for context compaction.")
			replacementSessionId = sessionId
			this.callbacks.log("contextCompactionSessionCreated", { requestId, sourceSessionId, sessionId, messagesBefore, initialMessages: command.initialMessages.length })
			await this.callbacks.applySuccess(sourceSessionId, compacted, messagesBefore, compacted.messagesAfter)
			try {
				await this.callbacks.cleanupSource(sourceSessionId)
			} catch (cleanupError) {
				this.callbacks.log("contextCompactionSourceCleanupFailed", { requestId, sourceSessionId, sessionId, error: stringify(cleanupError) })
			}
			return sessionId
		} catch (error) {
			this.callbacks.log("contextCompactionFailed", { requestId, sourceSessionId, error: stringify(error) })
			if (replacementSessionId) {
				try {
					await this.callbacks.rollbackReplacement(sourceSessionId, replacementSessionId)
				} catch (rollbackError) {
					this.callbacks.log("contextCompactionRollbackFailed", { requestId, sourceSessionId, replacementSessionId, error: stringify(rollbackError) })
				}
			}
			await this.callbacks.applyFailure(error)
			return undefined
		} finally {
			this.inFlight = false
		}
	}
}

function stringify(value: unknown) { return value instanceof Error ? value.message : String(value) }
function throwIfAborted(signal?: AbortSignal) { if (signal?.aborted) throw new Error("Context compaction was cancelled.") }
