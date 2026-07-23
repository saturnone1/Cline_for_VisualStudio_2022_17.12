import type { AgentCompactSessionRequest, AgentEnginePort } from "../../application/ports/AgentEnginePort"
import { CompactSessionFlow } from "../../features/chat/runtime/CompactSessionFlow"
import { buildCompactedConversationMessages } from "../conversation/ResumedConversationProjection"

type Message = Record<string, unknown>
type Dependencies = Readonly<{
	runtime: () => AgentEnginePort | null
	activeSessionId: () => string
	selectedSessionId: () => string
	language: () => "en" | "ko"
	currentTask: () => Message | null
	messages: () => Message[]
	workspaceRoot: () => Promise<string>
	buildConfig: (cwd: string) => Promise<Readonly<Record<string, unknown>>>
	toolPolicies: () => Readonly<Record<string, unknown>>
	setInProgress: (value: boolean) => void
	transition: (status: "starting" | "completed" | "failed", source: string) => void
	startProgress: (text: string) => void
	finishProgress: () => void
	addMessage: (message: Message) => void
	markClosing: (sessionId: string, closing?: boolean) => void
	bindSession: (sessionId: string) => void
	restoreState: (task: Message | null, messages: Message[]) => void
	advanceGeneration: () => void
	markSettingsActive: () => void
	updateTask: () => void
	persist: () => void
	broadcast: () => Promise<void>
	log: (event: string, details: Record<string, unknown>) => void
}>

export function createContextCompactionFlow(dependencies: Dependencies) {
	return new CompactSessionFlow({
		isRuntimeAvailable: () => Boolean(dependencies.runtime()),
		activeSessionId: dependencies.activeSessionId,
		selectedSessionId: dependencies.selectedSessionId,
		language: dependencies.language,
		transitionStarting: () => { dependencies.setInProgress(true); dependencies.transition("starting", "compact") },
		showProgress: dependencies.startProgress,
		persist: dependencies.persist,
		broadcast: dependencies.broadcast,
		buildRequest: (sourceSessionId, excludedText, signal) => buildRequest(dependencies, sourceSessionId, excludedText, signal),
		compact: (command) => requireRuntime(dependencies).compactSession(command),
		result: (result) => ({
			sessionId: stringField(result, "sessionId"),
			messagesAfter: numberField(result, "compactedMessageCount"),
			estimatedTokensAfter: numberField(result, "estimatedTokensAfter"),
			summary: stringField(result, "compactionSummary"),
		}),
		applySuccess: async (sourceSessionId, result, messagesBefore, messagesAfter) => {
			const previousTask = dependencies.currentTask()
			const previousMessages = [...dependencies.messages()]
			dependencies.setInProgress(false)
			dependencies.advanceGeneration()
			dependencies.markClosing(sourceSessionId)
			dependencies.bindSession(result.sessionId)
			dependencies.finishProgress()
			dependencies.addMessage({ type: "say", say: "info", text: dependencies.language() === "en" ? "Context compacted." : "컨텍스트 압축이 완료되었습니다.", contextCompaction: { sourceSessionId, sessionId: result.sessionId, messagesBefore, messagesAfter, estimatedTokensAfter: result.estimatedTokensAfter, summary: result.summary } })
			dependencies.transition("completed", "compact-complete")
			dependencies.markSettingsActive()
			dependencies.updateTask()
			try {
				dependencies.persist()
			} catch (error) {
				dependencies.restoreState(previousTask, previousMessages)
				dependencies.bindSession(sourceSessionId)
				dependencies.markClosing(sourceSessionId, false)
				throw error
			}
			await dependencies.broadcast().catch((error) => dependencies.log("contextCompactionBroadcastFailed", { error: stringify(error) }))
		},
		cleanupSource: async (sourceSessionId) => {
			const runtime = requireRuntime(dependencies)
			await runtime.stop({ sessionId: sourceSessionId })
			const deleted = await runtime.deleteSession({ sessionId: sourceSessionId })
			if (deleted !== true) throw new Error(`Compacted source session was not deleted: ${sourceSessionId}`)
		},
		rollbackReplacement: async (sourceSessionId, replacementSessionId) => {
			const runtime = requireRuntime(dependencies)
			const failures: string[] = []
			await runtime.stop({ sessionId: replacementSessionId }).catch((error) => failures.push(`stop: ${stringify(error)}`))
			const deleted = await runtime.deleteSession({ sessionId: replacementSessionId }).catch((error) => { failures.push(`delete: ${stringify(error)}`); return false })
			if (deleted !== true && !failures.some((failure) => failure.startsWith("delete:"))) failures.push("delete: replacement session was not deleted")
			const source = await runtime.activateSession(sourceSessionId).catch((error) => { failures.push(`activate source: ${stringify(error)}`); return null })
			if (!source && !failures.some((failure) => failure.startsWith("activate source:"))) failures.push("activate source: source session was not found")
			if (failures.length > 0) throw new Error(failures.join("; "))
		},
		applyFailure: async (error) => {
			dependencies.setInProgress(false)
			dependencies.finishProgress()
			dependencies.addMessage({
				type: "say",
				say: "error",
				text: dependencies.language() === "en"
					? "Context compaction could not be completed. The existing conversation was preserved."
					: "컨텍스트 압축을 완료하지 못했습니다. 기존 대화는 그대로 유지됩니다.",
			})
			dependencies.transition("failed", "compact-failed")
			dependencies.updateTask()
			await dependencies.broadcast()
		},
		messageCount: () => dependencies.messages().length,
		log: dependencies.log,
	})
}

async function buildRequest(dependencies: Dependencies, sourceSessionId: string, excludedText: string, signal?: AbortSignal): Promise<AgentCompactSessionRequest> {
	const task = dependencies.currentTask()
	const workspaceRoot = await dependencies.workspaceRoot()
	const cwd = workspaceRoot || stringField(task, "cwdOnTaskInitialization")
	const initialMessages = buildCompactedConversationMessages(dependencies.messages(), excludedText)
	return {
		sourceSessionId,
		cwd,
		initialMessages,
		sessionMetadata: { title: stringField(task, "task"), ligVsContextCompaction: true, ligVsCompactedInitialMessageCount: initialMessages.length },
		config: await dependencies.buildConfig(cwd),
		toolPolicies: dependencies.toolPolicies(),
		signal,
	}
}

function requireRuntime(dependencies: Dependencies) { const runtime = dependencies.runtime(); if (!runtime) throw new Error("LIG VS SDK runtime is not attached."); return runtime }
function stringField(value: unknown, key: string) { if (!value || typeof value !== "object" || !(key in value)) return ""; const field = (value as Record<string, unknown>)[key]; return typeof field === "string" ? field : "" }
function numberField(value: unknown, key: string) { if (!value || typeof value !== "object" || !(key in value)) return 0; const field = (value as Record<string, unknown>)[key]; return typeof field === "number" && Number.isFinite(field) ? field : 0 }
function stringify(value: unknown) { return value instanceof Error ? value.message : String(value) }
