import { EmptyRequest } from "@shared/proto/cline/common"
import { useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { TaskServiceClient } from "@/services/grpcClient"

const ACTIVE_STATUSES = new Set(["starting", "streaming", "awaiting_user", "cancelling"])

export default function BackgroundTaskStatus({ visible }: { visible: boolean }) {
	const { currentTaskItem, taskLifecycleStatus, navigateToChat } = useExtensionState()
	const [cancelError, setCancelError] = useState("")
	const [cancelPending, setCancelPending] = useState(false)
	const active = Boolean(currentTaskItem && ACTIVE_STATUSES.has(taskLifecycleStatus || ""))
	if (!visible || (!active && !cancelError)) return null

	const cancel = async () => {
		if (cancelPending) return
		setCancelPending(true)
		setCancelError("")
		try {
			await TaskServiceClient.cancelTask(EmptyRequest.create({}))
		} catch (error) {
			setCancelError(error instanceof Error ? error.message : String(error))
		} finally {
			setCancelPending(false)
		}
	}

	return (
		<div className="lig-background-task-status" role="status">
			<span className={`codicon ${cancelError ? "codicon-error" : "codicon-loading codicon-modifier-spin"}`} />
			<span className="min-w-0 flex-1 truncate">
				{cancelError ? `대화 작업 취소 실패: ${cancelError}` : taskLifecycleStatus === "cancelling" ? "대화 작업을 취소하는 중입니다." : "대화 작업이 백그라운드에서 진행 중입니다."}
			</span>
			<button className="lig-background-task-action" onClick={navigateToChat} type="button">대화 보기</button>
			{active && taskLifecycleStatus !== "cancelling" && (
				<button className="lig-background-task-action danger" disabled={cancelPending} onClick={cancel} type="button">취소</button>
			)}
		</div>
	)
}
