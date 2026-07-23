import type { AgentEnginePort } from "../../application/ports/AgentEnginePort"
import type { TaskHistoryItem } from "../../features/taskHistory/TaskHistoryCollection"
import { TaskHistoryCommands } from "../../features/taskHistory/TaskHistoryCommands"
import { TaskHistorySync } from "../../features/taskHistory/TaskHistorySync"
import type { TaskStateCoordinator } from "../../features/taskHistory/TaskStateCoordinator"
import { sdkSessionToHistoryItem } from "../conversation/TaskHistoryProjection"
import { RUNTIME_DEFAULTS, readBoundedPositiveIntEnv } from "../configuration/RuntimeEnvironment"

type Task = Record<string, unknown>
type Dependencies = Readonly<{
	runtime: () => AgentEnginePort | null
	history: () => readonly TaskHistoryItem[]
	writeHistory: (history: TaskHistoryItem[]) => void
	currentTask: () => Task | null
	writeCurrentTask: (task: Task | null) => void
	clearMessages: () => void
	clearLiveInteraction: (reason: string) => void
	taskState: TaskStateCoordinator
	persist: () => void
	broadcast: () => Promise<void>
	log: (event: string, details: Record<string, unknown>) => void
}>

export function createTaskHistoryComposition(dependencies: Dependencies) {
	const historyLimit = readHistoryLimit()
	const sync = new TaskHistorySync({
		isAvailable: () => Boolean(dependencies.runtime()),
		listHistory: () => dependencies.runtime()?.listHistory({ limit: historyLimit }) ?? Promise.resolve(null),
		projectSession: (session) => sdkSessionToHistoryItem(asRecord(session)),
		readHistory: dependencies.history,
		writeHistory: dependencies.writeHistory,
		broadcast: dependencies.broadcast,
		log: dependencies.log,
	})
	const commands = new TaskHistoryCommands({
		readHistory: dependencies.history,
		writeHistory: dependencies.writeHistory,
		readCurrentTask: dependencies.currentTask,
		writeCurrentTask: dependencies.writeCurrentTask,
		clearMessages: dependencies.clearMessages,
		clearLiveInteraction: dependencies.clearLiveInteraction,
		markDeleted: (taskId) => sync.markDeleted(taskId),
		removeDeleted: (history) => sync.removeDeleted(history),
		listRemoteTaskIds: async () => {
			const runtime = dependencies.runtime()
			if (!runtime) return []
			const sessions = await runtime.listHistory({ limit: historyLimit })
			return Array.isArray(sessions) ? sessions.map((session) => stringField(session, "id") || stringField(session, "sessionId")).filter(Boolean) : []
		},
		deleteRemote: (taskId) => dependencies.runtime()?.deleteSession({ sessionId: taskId }) ?? Promise.resolve(undefined),
		updateRemoteFavorite: (taskId, isFavorited) => dependencies.runtime()?.updateSession({ sessionId: taskId, metadata: { isFavorited } }) ?? Promise.resolve(undefined),
		getSnapshot: (taskId) => dependencies.taskState.getSnapshot(taskId),
		rememberSnapshot: (taskId, task, messages) => dependencies.taskState.remember(taskId, task, messages),
		forgetSnapshot: (taskId) => dependencies.taskState.forget(taskId),
		clearSnapshots: () => dependencies.taskState.clearSnapshots(),
		persist: dependencies.persist,
		log: dependencies.log,
	})
	return { sync, commands }
}

function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function stringField(value: unknown, key: string) { const field = asRecord(value)[key]; return typeof field === "string" ? field : "" }
export function readHistoryLimit() {
	return readBoundedPositiveIntEnv("VSCLINE_HISTORY_SYNC_LIMIT", RUNTIME_DEFAULTS.historySyncEntries, 1, 10_000)
}
