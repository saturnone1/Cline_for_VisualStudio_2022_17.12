import { CheckIcon, CopyIcon } from "lucide-react"
import { useCallback, useState } from "react"
import { StringRequest } from "@shared/proto/cline/common"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { FileServiceClient } from "@/services/grpcClient"

const CopyTaskButton: React.FC<{
	taskText?: string
	className?: string
}> = ({ taskText, className }) => {
	const [copied, setCopied] = useState(false)

	const handleCopy = useCallback(() => {
		if (!taskText) {
			return
		}

		const copyPromise = navigator.clipboard?.writeText
			? navigator.clipboard.writeText(taskText).catch(() => FileServiceClient.copyToClipboard(StringRequest.create({ value: taskText })))
			: FileServiceClient.copyToClipboard(StringRequest.create({ value: taskText }))

		copyPromise.then(() => {
			setCopied(true)
			setTimeout(() => setCopied(false), 1500)
		})
	}, [taskText])

	return (
		<Tooltip>
			<TooltipContent side="bottom">Copy Text</TooltipContent>
			<TooltipTrigger className={cn("flex items-center", className)}>
				<Button
					aria-label="Copy"
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
