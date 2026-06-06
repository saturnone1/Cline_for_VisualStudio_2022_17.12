import type { ClineMessage } from "@shared/ExtensionMessage"
import type { Mode } from "@shared/storage/types"
import type React from "react"
import { useMemo } from "react"
import ErrorRow from "./ErrorRow"
import { ThinkingRow } from "./ThinkingRow"

interface RequestStartRowProps {
	message: ClineMessage
	apiRequestFailedMessage?: string
	apiReqStreamingFailedMessage?: string
	cost?: number
	mode?: Mode
	classNames?: string
	isExpanded: boolean
	handleToggle: () => void
}

const getApiRequestSummary = (text?: string) => {
	if (!text) {
		return ""
	}

	try {
		const request = String(JSON.parse(text).request || "").trim()
		return request
	} catch {
		return ""
	}
}

/**
 * Displays the current state of an active tool operation,
 */
export const RequestStartRow: React.FC<RequestStartRowProps> = ({
	apiRequestFailedMessage,
	apiReqStreamingFailedMessage,
	cost,
	handleToggle,
	isExpanded,
	message,
}) => {
	const hasError = !!(apiRequestFailedMessage || apiReqStreamingFailedMessage)
	const hasCost = cost != null
	const apiRequestSummary = useMemo(() => getApiRequestSummary(message.text), [message.text])

	return (
		<div className={apiRequestSummary && !hasError ? "lig-progress-row" : undefined}>
			{apiRequestSummary && !hasError && (
				<ThinkingRow
					isExpanded={isExpanded}
					isVisible={true}
					onToggle={handleToggle}
					reasoningContent={apiRequestSummary}
					showTitle={true}
					isStreaming={!hasCost}
					title={message.partial === true ? "모델 진행 중" : "모델 진행 기록"}
				/>
			)}

			{hasError && (
				<ErrorRow
					apiReqStreamingFailedMessage={apiReqStreamingFailedMessage}
					apiRequestFailedMessage={apiRequestFailedMessage}
					errorType="error"
					message={message}
				/>
			)}
		</div>
	)
}
