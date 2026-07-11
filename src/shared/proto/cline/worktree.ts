import { createProtoStub } from "../protoStub"

export type CreateWorktreeIncludeRequest = { content: string }
export const CreateWorktreeIncludeRequest = createProtoStub<CreateWorktreeIncludeRequest>("CreateWorktreeIncludeRequest")

export type CreateWorktreeRequest = {
	path: string
	branch: string
	baseBranch?: string
	createNewBranch?: boolean
}
export const CreateWorktreeRequest = createProtoStub<CreateWorktreeRequest>("CreateWorktreeRequest")

export type DeleteWorktreeRequest = {
	path: string
	force?: boolean
	deleteBranch?: boolean
	branchName?: string
}
export const DeleteWorktreeRequest = createProtoStub<DeleteWorktreeRequest>("DeleteWorktreeRequest")

export type MergeWorktreeRequest = {
	worktreePath: string
	targetBranch: string
	deleteAfterMerge?: boolean
}
export const MergeWorktreeRequest = createProtoStub<MergeWorktreeRequest>("MergeWorktreeRequest")

export type MergeWorktreeResult = {
	success: boolean
	message?: string
	hasConflicts?: boolean
	conflictingFiles: string[]
	recoveryPrompt?: string
	recoveryCommands?: string[]
	sourceWorktreePath?: string
	sourceBranch?: string
	targetWorktreePath?: string
	targetBranch?: string
}
export const MergeWorktreeResult = createProtoStub<MergeWorktreeResult>("MergeWorktreeResult")

export type SwitchWorktreeRequest = { path: string; newWindow?: boolean; solutionPath?: string }
export const SwitchWorktreeRequest = createProtoStub<SwitchWorktreeRequest>("SwitchWorktreeRequest")

export type TrackWorktreeViewOpenedRequest = { source: string }
export const TrackWorktreeViewOpenedRequest = createProtoStub<TrackWorktreeViewOpenedRequest>("TrackWorktreeViewOpenedRequest")

export type Worktree = {
	path: string
	branch?: string
	isBare?: boolean
	isCurrent?: boolean
	isDetached?: boolean
	isLocked?: boolean
	lockReason?: string
	isPrunable?: boolean
	prunableReason?: string
	dirty?: boolean
	statusSummary?: string
	statusEntries?: Array<{ code?: string; path?: string }>
	conflictCount?: number
}
export const Worktree = createProtoStub<Worktree>("Worktree")
