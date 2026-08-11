import type { InteractionLoggerPort } from "../../application/ports/InteractionLoggerPort"
import { readPositiveIntEnv } from "../configuration/RuntimeEnvironment"
import type { WorkspaceChange } from "../../domain/agent/AgentRuntimeEvent"
import { terminalTaskOutcome } from "../../domain/task/TaskLifecycle"
import { AgentEventDispatcher } from "../../features/runtime/AgentEventDispatcher"
import { AgentRuntimeEventDispatcher } from "../../features/runtime/AgentRuntimeEventDispatcher"
import type { RuntimeMonitoringCoordinator } from "../../features/runtime/RuntimeMonitoringCoordinator"
import type { TaskSessionCoordinator } from "../../features/runtime/TaskSessionCoordinator"
import type { BrowserToolEventFlow } from "../../features/browser/BrowserToolEventFlow"
import type { HookLifecycleCoordinator } from "../../features/hooks/HookLifecycleCoordinator"
import type { TaskStateCoordinator } from "../../features/taskHistory/TaskStateCoordinator"
import { AgentAuxiliaryEventProjector } from "../conversation/AgentAuxiliaryEventProjector"
import { AgentChunkEventProjector } from "../conversation/AgentChunkEventProjector"
import { AgentLifecycleEventProjector, type CompactionNotice } from "../conversation/AgentLifecycleEventProjector"
import { AgentSnapshotEventProjector } from "../conversation/AgentSnapshotEventProjector"
import { AgentTextEventProjector } from "../conversation/AgentTextEventProjector"
import { AgentToolEventProjector } from "../conversation/AgentToolEventProjector"
import type { ConversationActivityProjector } from "../conversation/ConversationActivityProjector"
import type { ConversationMessageStore } from "../conversation/ConversationMessageStore"
import type { ConversationProjectionState } from "../../features/conversation/ConversationProjectionState"
import type { ConversationRuntimeProjector } from "../conversation/ConversationRuntimeProjector"
import type { FoldedProgressProjector } from "../conversation/FoldedProgressProjector"
import type { PartialTextProjector } from "../conversation/PartialTextProjector"
import { RuntimeStatusEventProjector } from "../conversation/RuntimeStatusEventProjector"
import { projectAssistantTranscript } from "../conversation/StructuredAssistantResponse"
import type { TaskCompletionProjector } from "../conversation/TaskCompletionProjector"
import { formatProviderErrorForTranscript, stringify } from "./RuntimeErrorFormatter"
import { summarizeAgentChunkForLog } from "./WebviewInteractionLogSupport"
import { WebviewRuntimeEventIngress } from "./WebviewRuntimeEventIngress"

type Dependencies = Readonly<{
	logger: InteractionLoggerPort
	monitoring: RuntimeMonitoringCoordinator
	session: TaskSessionCoordinator
	activity: ConversationActivityProjector
	folded: FoldedProgressProjector
	runtime: ConversationRuntimeProjector
	projection: ConversationProjectionState
	partial: PartialTextProjector
	completion: TaskCompletionProjector
	messages: ConversationMessageStore
	taskState: TaskStateCoordinator
	hooks: HookLifecycleCoordinator
	browserTools: BrowserToolEventFlow
	startTerminal: () => void
	stopTerminal: () => void
	pollTerminal: () => Promise<void>
	shouldSuppressTrackedEdit: (toolName: string, trackedPath: string) => boolean
	trackWorkspaceChange: (change: WorkspaceChange) => void
	activeSessionId: () => string
	currentTaskId: () => string
	language: () => "en" | "ko"
	recentTexts: () => string[]
	broadcast: () => Promise<void>
	setCompactionStatus: (notice: CompactionNotice) => void
}>

export function createAgentEventProjectionComposition(deps: Dependencies) {
	const broadcast = () => {
		void deps.broadcast().catch((error) => console.error(error))
	}
	const finishTask = (sessionId: string, status: string, text = "") => {
		if (terminalTaskOutcome(status) === "failed") deps.session.markClosing(sessionId)
		deps.completion.finish(sessionId, status, text)
	}
	const textEvents = new AgentTextEventProjector({
		noteActivity: (reason) => deps.monitoring.noteActivity(reason),
		clearReasoning: () => deps.activity.clearReasoning(),
		recordReasoning: (text) => deps.activity.recordReasoning(text),
		foldReasoning: (text) => deps.folded.upsertReasoning(text),
		upsertAssistant: (accumulated, delta) => deps.runtime.upsertAssistant(accumulated, delta),
		completeAssistant: (text) => deps.runtime.completeAssistant(text),
		activeAssistantText: () => deps.projection.activeAssistantTextBuffer,
	})
	const toolEvents = new AgentToolEventProjector({
		noteActivity: (reason) => deps.monitoring.noteActivity(reason),
		clearReasoning: () => deps.activity.clearReasoning(),
		clearPartial: () => {
			deps.monitoring.clearPartialIdle()
			deps.projection.activePartialTextTs = null
		},
		recordActivity: (tool, text) => deps.runtime.recordToolActivity(tool, text),
		startTerminal: deps.startTerminal,
		stopTerminal: deps.stopTerminal,
		finalPollTerminal: () => {
			void deps.pollTerminal().catch((error) => deps.logger.log("sidecar", "terminalStateFinalPollFailed", { message: stringify(error) }))
		},
		postToolUse: (event) => {
			void deps.hooks.run("PostToolUse", {
				sessionId: event.sessionId,
				toolName: event.toolName,
				input: event.input,
				output: event.output,
				error: event.error,
				iteration: event.iteration,
			})
		},
		handleBrowser: (tool, input, error, output) => {
			void deps.browserTools.execute(tool, input, error, output).catch((projectionError) => {
				deps.logger.log("sidecar", "browserToolProjectionFailed", { tool, error: stringify(projectionError) })
			})
		},
		shouldSuppressTrackedEdit: deps.shouldSuppressTrackedEdit,
		rememberSummary: (tool, text) => deps.activity.rememberToolSummary(tool, text),
		appendTerminal: (text) => deps.folded.appendTerminal(text),
		moveProgressToEnd: () => deps.folded.moveActiveToEnd(),
		language: deps.language,
	})
	const lifecycleEvents = new AgentLifecycleEventProjector({
		noteActivity: (reason) => deps.monitoring.noteActivity(reason),
		clearReasoning: () => deps.activity.clearReasoning(),
		finishToolActivity: () => deps.runtime.finishToolActivity(),
		finishProgress: () => deps.folded.finish(),
		finalizePartial: () => deps.partial.finalize(),
		addText: (text) => deps.messages.add(projectAssistantTranscript(text)),
		addError: (text) => deps.messages.add({ type: "say", say: "error", text }),
		finishTask,
		updateUsage: (usage) => deps.taskState.update(usage),
		recordContextUsage: (usage) => deps.messages.add({
			type: "say",
			say: "api_req_started",
			text: JSON.stringify({
				request: "",
				tokensIn: usage.tokensIn || 0,
				tokensOut: usage.tokensOut || 0,
				cacheReads: usage.cacheReads || 0,
				cacheWrites: usage.cacheWrites || 0,
				cost: usage.totalCost || 0,
				usageReliable: true,
			}),
			partial: false,
			isCollapsed: true,
			isExpanded: false,
		}),
		hasCompletion: () => deps.completion.hasCompletionAfterLastUser(),
		activePartialText: () => deps.partial.activeText(),
		hasAssistantAfterUser: () => deps.completion.hasAssistantAfterLastUser(),
		log: (event, details) => deps.logger.log("sidecar", event, details),
		formatError: (error) => formatProviderErrorForTranscript(error, deps.language()),
		markErrorLatency: (sessionId, error) => deps.monitoring.markError(sessionId, error),
		quarantineSession: (sessionId) => deps.session.markClosing(sessionId),
		setCompactionStatus: deps.setCompactionStatus,
	})
	const semanticEvents = new AgentEventDispatcher({
		bindSession: (sessionId) => deps.session.bindSession(sessionId),
		projectText: (event) => textEvents.handle(event),
		projectTool: (event) => toolEvents.handle(event),
		projectLifecycle: (event) => lifecycleEvents.handle(event),
		updateTask: () => deps.taskState.update(),
		broadcast,
	})
	const auxiliaryEvents = new AgentAuxiliaryEventProjector({
		noteActivity: (reason) => deps.monitoring.noteActivity(reason),
		addMessage: (message) => deps.messages.add(message),
		updateTask: () => deps.taskState.update(),
		broadcast,
		log: (event, details) => deps.logger.log("sidecar", event, details),
	})
	const snapshotEvents = new AgentSnapshotEventProjector({
		bindSession: (sessionId) => deps.session.bindSession(sessionId),
		finishTask,
		noteActivity: (reason) => deps.monitoring.noteActivity(reason),
		activeText: () => deps.partial.activeText(),
		hasTurnCompletionEvidence: () => Boolean(deps.partial.activeText().trim() || deps.completion.hasAssistantAfterLastUser()),
		updateTask: (updates) => deps.taskState.update(updates),
		broadcast,
	})
	const chunkEvents = new AgentChunkEventProjector({
		noteActivity: (reason) => deps.monitoring.noteActivity(reason),
		noteQuietActivity: (reason) => deps.monitoring.noteQuietActivity(reason),
		finishTask: (status, text) => finishTask(deps.activeSessionId() || deps.currentTaskId(), status, text),
		addMessage: (message) => deps.messages.add(message),
		recordTool: (text) => deps.runtime.recordToolActivity("tool", text),
		foldReasoning: (text) => deps.folded.upsertReasoning(text),
		updateTask: () => deps.taskState.update(),
		broadcast,
		schedulePartial: () => deps.monitoring.schedulePartialBroadcast(),
		recentTexts: deps.recentTexts,
		commandOutputLimit: () => readPositiveIntEnv("VSCLINE_COMMAND_OUTPUT_CHARS", 12000),
		agentTranscriptLimit: () => readPositiveIntEnv("VSCLINE_AGENT_TRANSCRIPT_CHARS", 12000),
		logSkipped: (chunk) => deps.logger.log("sidecar", "sdkAgentChunkSkippedForUi", summarizeAgentChunkForLog(chunk)),
	})
	const statusEvents = new RuntimeStatusEventProjector({
		shouldIgnore: (sessionId) => deps.session.shouldIgnoreEvent(sessionId),
		markFirstEvent: (sessionId, eventType) => deps.monitoring.markFirstSdkEvent(sessionId, eventType),
		activeText: () => deps.partial.activeText(),
		hasTurnCompletionEvidence: () => Boolean(deps.partial.activeText().trim() || deps.completion.hasAssistantAfterLastUser()),
		finishTask,
		updateTask: () => deps.taskState.update(),
		broadcast,
		transitionStreaming: (source) => deps.session.transition("streaming", source),
		noteActivity: (reason) => deps.monitoring.noteActivity(reason),
		schedulePartial: () => deps.monitoring.schedulePartialBroadcast(),
		log: (event, details) => deps.logger.log("sidecar", event, details),
	})
	const runtimeEvents = new AgentRuntimeEventDispatcher({
		transitionStreaming: (source) => deps.session.transition("streaming", source),
		shouldIgnore: (sessionId) => deps.session.shouldIgnoreEvent(sessionId),
		markFirstEvent: (sessionId, eventType) => deps.monitoring.markFirstSdkEvent(sessionId, eventType),
		projectAgent: (event, sessionId) => semanticEvents.handle(event, sessionId),
		trackWorkspaceChange: deps.trackWorkspaceChange,
		projectChunk: (event) => chunkEvents.handle(event),
		projectSnapshot: (event) => snapshotEvents.handle(event),
		projectAuxiliary: (event) => auxiliaryEvents.handle(event),
		projectLifecycle: (event) => statusEvents.handle(event),
		log: (event, details) => deps.logger.log("sidecar", event, details),
		activeSessionId: deps.activeSessionId,
		currentTaskId: deps.currentTaskId,
	})
	return new WebviewRuntimeEventIngress(deps.logger, runtimeEvents, (sessionId) => deps.monitoring.correlationId(sessionId))
}
