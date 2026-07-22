import React, { useMemo } from "react"
import Thumbnails from "@/components/common/Thumbnails"
import { highlightText } from "./taskHeader/Highlights"

interface UserMessageProps {
	text?: string
	files?: string[]
	images?: string[]
}

const UserMessage: React.FC<UserMessageProps> = ({ text, images, files }) => {
	const highlightedText = useMemo(() => highlightText(text), [text])
	const hasAttachments = (images?.length ?? 0) > 0 || (files?.length ?? 0) > 0

	return (
		<div className="lig-user-message-row">
			<div className="lig-user-message" data-testid="user-message">
				{text && (
					<span className="ph-no-capture block whitespace-pre-wrap break-words text-sm">{highlightedText}</span>
				)}
				{hasAttachments && (
					<Thumbnails files={files ?? []} images={images ?? []} style={text ? { marginTop: "8px" } : undefined} />
				)}
			</div>
		</div>
	)
}

export default UserMessage
