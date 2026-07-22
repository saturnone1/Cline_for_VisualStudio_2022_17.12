import { FoldVerticalIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

const CompactTaskButton: React.FC<{
	className?: string
	disabled?: boolean
	onClick: (e: React.MouseEvent<HTMLButtonElement>) => void
	showLabel?: boolean
	language?: "en" | "ko"
}> = ({ onClick, className, disabled = false, showLabel = false, language = "en" }) => {
	const label = language === "ko" ? "대화 압축" : "Compact conversation"
	return (
		<Tooltip>
			<TooltipContent side="left">{label}</TooltipContent>
			<TooltipTrigger asChild className={cn("flex items-center", className)}>
				<Button
					aria-label={label}
					className={cn("[&_svg]:size-3", showLabel && "px-2 h-6 text-xs")}
					disabled={disabled}
					onClick={(e) => {
						e.preventDefault()
						e.stopPropagation()
						if (disabled) {
							return
						}
						onClick(e)
					}}
					size={showLabel ? "xs" : "icon"}
					variant={showLabel ? "ghost" : "icon"}>
					<FoldVerticalIcon />
					{showLabel && <span>{label}</span>}
				</Button>
			</TooltipTrigger>
		</Tooltip>
	)
}

export default CompactTaskButton
