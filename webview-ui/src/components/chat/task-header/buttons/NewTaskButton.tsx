import { ArrowLeftIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { useI18n } from "@/i18n"

const NewTaskButton: React.FC<{
	onClick: () => void
	className?: string
}> = ({ className, onClick }) => {
	const { language } = useI18n()
	const label = language === "ko" ? "작업 목록으로" : "Back to tasks"
	return (
		<Tooltip>
			<TooltipContent side="left">{label}</TooltipContent>
			<TooltipTrigger className={cn("flex items-center", className)}>
				<Button
					aria-label={label}
					onClick={(e) => {
						e.preventDefault()
						e.stopPropagation()
						onClick()
					}}
					size="icon"
					variant="icon">
					<ArrowLeftIcon className="size-4" />
				</Button>
			</TooltipTrigger>
		</Tooltip>
	)
}

export default NewTaskButton
