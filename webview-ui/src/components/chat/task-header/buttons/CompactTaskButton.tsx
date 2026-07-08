import { FoldVerticalIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

const CompactTaskButton: React.FC<{
	className?: string
	disabled?: boolean
	onClick: (e: React.MouseEvent<HTMLButtonElement>) => void
	showLabel?: boolean
}> = ({ onClick, className, disabled = false, showLabel = false }) => {
	return (
		<Tooltip>
			<TooltipContent side="left">Compact Task</TooltipContent>
			<TooltipTrigger asChild className={cn("flex items-center", className)}>
				<Button
					aria-label="Compact Task"
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
					{showLabel && <span>Compact</span>}
				</Button>
			</TooltipTrigger>
		</Tooltip>
	)
}

export default CompactTaskButton
