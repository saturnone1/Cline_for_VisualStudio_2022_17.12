import { createProtoStub } from "../protoStub"

export type CheckpointRestoreRequest = {
	number: number
	restoreType: "task" | "workspace" | "taskAndWorkspace"
}
export const CheckpointRestoreRequest = createProtoStub<CheckpointRestoreRequest>("CheckpointRestoreRequest")
