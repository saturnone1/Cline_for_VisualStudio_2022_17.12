import { ClineMessage } from "@shared/ExtensionMessage"
import type { ContextWindowUsage } from "@shared/getApiMetrics"
import React from "react"
import TaskHeader from "@/components/chat/taskHeader/TaskHeader"
import { MessageHandlers } from "../../types/chatTypes"

interface TaskSectionProps {
	task: ClineMessage
	messages: ClineMessage[]
	apiMetrics: {
		totalTokensIn: number
		totalTokensOut: number
		totalCacheWrites?: number
		totalCacheReads?: number
		totalCost: number
	}
	contextWindowUsage?: ContextWindowUsage
	compactResetKey?: number
	contextCompactionInProgress?: boolean
	contextCompactionThreshold?: number
	lastApiReqTotalTokens?: number
	selectedModelInfo: {
		supportsPromptCache: boolean
		supportsImages: boolean
	}
	messageHandlers: MessageHandlers
	lastProgressMessageText?: string
	showFocusChainPlaceholder?: boolean
}

/**
 * Task section shown when there's an active task
 * Includes the task header and manages task-specific UI
 */
export const TaskSection: React.FC<TaskSectionProps> = ({
	task,
	messages,
	apiMetrics,
	contextWindowUsage,
	compactResetKey,
	contextCompactionInProgress,
	contextCompactionThreshold,
	lastApiReqTotalTokens,
	selectedModelInfo,
	messageHandlers,
	lastProgressMessageText,
	showFocusChainPlaceholder,
}) => {
	return (
		<TaskHeader
			cacheReads={apiMetrics.totalCacheReads}
			cacheWrites={apiMetrics.totalCacheWrites}
			doesModelSupportPromptCache={selectedModelInfo.supportsPromptCache}
			compactResetKey={compactResetKey}
			contextCompactionInProgress={contextCompactionInProgress}
			contextCompactionThreshold={contextCompactionThreshold}
			contextWindowUsage={contextWindowUsage}
			lastApiReqTotalTokens={lastApiReqTotalTokens}
			lastProgressMessageText={lastProgressMessageText}
			messages={messages}
			onCompact={messageHandlers.handleCompactTask}
			onClose={messageHandlers.handleTaskCloseButtonClick}
			showFocusChainPlaceholder={showFocusChainPlaceholder}
			task={task}
			tokensIn={apiMetrics.totalTokensIn}
			tokensOut={apiMetrics.totalTokensOut}
			totalCost={apiMetrics.totalCost}
		/>
	)
}
