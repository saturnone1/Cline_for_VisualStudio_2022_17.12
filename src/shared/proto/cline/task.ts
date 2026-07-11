import { createProtoStub } from "../protoStub"

export type AskResponseRequest = {
	responseType: string
	text?: string
	images?: string[]
	files?: string[]
}
export const AskResponseRequest = createProtoStub<AskResponseRequest>("AskResponseRequest")

export type GetTaskHistoryRequest = {
	favoritesOnly?: boolean
	searchQuery?: string
	sortBy?: "newest" | "oldest" | "mostTokens" | "mostRelevant"
	currentWorkspaceOnly?: boolean
}
export const GetTaskHistoryRequest = createProtoStub<GetTaskHistoryRequest>("GetTaskHistoryRequest")

export type NewTaskRequest = {
	text?: string
	images?: string[]
	files?: string[]
	workspacePath?: string
	worktreePath?: string
}
export const NewTaskRequest = createProtoStub<NewTaskRequest>("NewTaskRequest")

export type TaskFavoriteRequest = {
	taskId: string
	isFavorited: boolean
}
export const TaskFavoriteRequest = createProtoStub<TaskFavoriteRequest>("TaskFavoriteRequest")
