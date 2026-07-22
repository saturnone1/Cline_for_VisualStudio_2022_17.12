import type { ClineMessage } from "@shared/ExtensionMessage"
import { CheckIcon, CopyIcon } from "lucide-react"
import { useCallback, useState } from "react"
import { StringRequest } from "@shared/proto/cline/common"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { FileServiceClient } from "@/services/grpcClient"
import { formatTaskTranscript } from "../taskTranscript"

const CopyTaskButton: React.FC<{
	messages: ClineMessage[]
	language: "en" | "ko"
	className?: string
}> = ({ messages, language, className }) => {
	const [copied, setCopied] = useState(false)

	const handleCopy = useCallback(() => {
		const transcript = formatTaskTranscript(messages, language)
		if (!transcript) {
			return
		}

		const copyPromise = navigator.clipboard?.writeText
			? navigator.clipboard.writeText(transcript).catch(() => FileServiceClient.copyToClipboard(StringRequest.create({ value: transcript })))
			: FileServiceClient.copyToClipboard(StringRequest.create({ value: transcript }))

		copyPromise.then(() => {
			setCopied(true)
			setTimeout(() => setCopied(false), 1500)
		})
	}, [language, messages])

	return (
		<Tooltip>
			<TooltipContent side="bottom">{language === "ko" ? "세션 대화 전체 복사" : "Copy entire session"}</TooltipContent>
			<TooltipTrigger className={cn("flex items-center", className)}>
				<Button
					aria-label={language === "ko" ? "세션 대화 전체 복사" : "Copy entire session"}
					onClick={(e) => {
						e.preventDefault()
						e.stopPropagation()
						handleCopy()
					}}
					size="icon"
					variant="icon">
					{copied ? <CheckIcon /> : <CopyIcon />}
				</Button>
			</TooltipTrigger>
		</Tooltip>
	)
}

export default CopyTaskButton
