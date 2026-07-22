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
	markClosing: (sessionId: string) => void
	bindSession: (sessionId: string) => void
	advanceGeneration: () => void
	markSettingsActive: () => void
	updateTask: () => void
	persist: () => void
	broadcast: () => Promise<void>
	formatError: (error: unknown) => string
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
			dependencies.setInProgress(false)
			dependencies.advanceGeneration()
			dependencies.markClosing(sourceSessionId)
			dependencies.bindSession(result.sessionId)
			dependencies.finishProgress()
			dependencies.addMessage({ type: "say", say: "info", text: dependencies.language() === "en" ? "Context compacted." : "컨텍스트 압축이 완료되었습니다.", contextCompaction: { sourceSessionId, sessionId: result.sessionId, messagesBefore, messagesAfter, estimatedTokensAfter: result.estimatedTokensAfter, summary: result.summary } })
			dependencies.transition("completed", "compact-complete")
			dependencies.markSettingsActive()
			dependencies.updateTask()
			dependencies.persist()
			await dependencies.broadcast()
		},
		applyFailure: async (error) => {
			dependencies.setInProgress(false)
			dependencies.finishProgress()
			dependencies.addMessage({ type: "say", say: "error", text: dependencies.formatError(error) })
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
