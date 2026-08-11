import { CheckpointRestoreRequest } from "@shared/proto/cline/checkpoints"
import { Int64Request } from "@shared/proto/cline/common"
import type { ClineCheckpointRestore } from "@shared/WebviewMessage"
import { useCallback, useEffect, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { CheckpointsServiceClient } from "@/services/grpcClient"

export function useCheckpointActions(messageTs?: number) {
	const [comparePending, setComparePending] = useState(false)
	const [restoreTaskPending, setRestoreTaskPending] = useState(false)
	const [restoreWorkspacePending, setRestoreWorkspacePending] = useState(false)
	const [restoreBothPending, setRestoreBothPending] = useState(false)
	const { onRelinquishControl } = useExtensionState()

	const reset = useCallback(() => {
		setComparePending(false)
		setRestoreTaskPending(false)
		setRestoreWorkspacePending(false)
		setRestoreBothPending(false)
	}, [])

	useEffect(() => onRelinquishControl(reset), [onRelinquishControl, reset])

	const compare = useCallback(async () => {
		setComparePending(true)
		try {
			await CheckpointsServiceClient.checkpointDiff(Int64Request.create({ value: messageTs }))
		} catch (error) {
			console.error("Checkpoint compare failed:", error)
		} finally {
			setComparePending(false)
		}
	}, [messageTs])

	const restore = useCallback(
		async (restoreType: ClineCheckpointRestore, setPending: (pending: boolean) => void) => {
			setPending(true)
			try {
				await CheckpointsServiceClient.checkpointRestore(
					CheckpointRestoreRequest.create({ number: messageTs, restoreType }),
				)
			} catch (error) {
				console.error(`Checkpoint ${restoreType} restore failed:`, error)
			} finally {
				setPending(false)
			}
		},
		[messageTs],
	)

	return {
		compare,
		comparePending,
		restoreBoth: () => restore("taskAndWorkspace", setRestoreBothPending),
		restoreBothPending,
		restoreTask: () => restore("task", setRestoreTaskPending),
		restoreTaskPending,
		restoreWorkspace: () => restore("workspace", setRestoreWorkspacePending),
		restoreWorkspacePending,
	}
}
