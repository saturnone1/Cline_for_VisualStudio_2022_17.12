import type { TaskCommand, TaskPromptRequest } from "../../features/chat/TaskRpcHandler"
import { getAskResponseText } from "../conversation/ToolCommandFormatting"

export function decodeTaskRpcCommand(key: string, message: unknown): TaskCommand | undefined {
	const request = asRecord(message)
	switch (key) {
		case "TaskService.clearTask": return { type: "clear" }
		case "TaskService.newTask": return { type: "newTask", request: promptRequest(request) }
		case "TaskService.askResponse": return { type: "askResponse", request: promptRequest(request) }
		case "SlashService.condense": return { type: "compact" }
		case "TaskService.cancelTask": return { type: "cancel" }
		case "TaskService.getTaskHistory": return { type: "history" }
		case "TaskService.getTotalTasksSize": return { type: "historySize" }
		case "TaskService.showTaskWithId": return { type: "show", taskId: readString(request.value) || readString(request.taskId) }
		case "TaskService.deleteTasksWithIds": return { type: "delete", taskIds: stringArray(request.value) }
		case "TaskService.deleteAllTaskHistory": return { type: "deleteAll" }
		case "TaskService.toggleTaskFavorite": return { type: "toggleFavorite", taskId: readString(request.taskId), isFavorited: request.isFavorited === true }
		default: return undefined
	}
}

function promptRequest(request: Record<string, unknown>): TaskPromptRequest {
	return {
		text: readString(request.text),
		answerText: getAskResponseText(request),
		responseType: readString(request.responseType),
		images: stringArray(request.images),
		files: stringArray(request.files),
		workspacePath: readString(request.workspacePath) || readString(request.cwd) || readString(request.worktreePath),
		delivery: readString(request.delivery),
	}
}

function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function readString(value: unknown) { return typeof value === "string" ? value : value == null ? "" : String(value) }
function stringArray(value: unknown) { return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [] }
