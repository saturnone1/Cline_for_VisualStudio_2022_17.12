import { createProtoStub } from "../protoStub"

export type AskResponseRequest = {
	responseType: string
	text?: string
	images?: string[]
	files?: string[]
	clientOperationId?: string
}
export const AskResponseRequest = createProtoStub<AskResponseRequest>("AskResponseRequest")

export type GetTaskHistoryRequest = {
	favoritesOnly?: boolean
	searchQuery?: string
	sortBy?: "newest" | "oldest" | "mostTokens" | "mostRelevant"
	currentWorkspaceOnly?: boolean
	cursor?: number
	pageSize?: number
}
export const GetTaskHistoryRequest = createProtoStub<GetTaskHistoryRequest>("GetTaskHistoryRequest")

export type NewTaskRequest = {
	text?: string
	images?: string[]
	files?: string[]
	workspacePath?: string
	worktreePath?: string
	clientOperationId?: string
}
export const NewTaskRequest = createProtoStub<NewTaskRequest>("NewTaskRequest")

export type TaskFavoriteRequest = {
	taskId: string
	isFavorited: boolean
}
export const TaskFavoriteRequest = createProtoStub<TaskFavoriteRequest>("TaskFavoriteRequest")
