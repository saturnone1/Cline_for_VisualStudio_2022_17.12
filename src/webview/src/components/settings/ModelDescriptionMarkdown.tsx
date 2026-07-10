import { memo, useEffect, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface ModelDescriptionMarkdownProps {
	markdown?: string
	isPopup?: boolean
}

export const ModelDescriptionMarkdown = memo(({ markdown, isPopup }: ModelDescriptionMarkdownProps) => {
	const contentRef = useRef<HTMLDivElement>(null)
	const [isTruncated, setIsTruncated] = useState(false)
	const [isExpanded, setIsExpanded] = useState(false)

	useEffect(() => {
		setIsExpanded(false)
	}, [markdown])

	useEffect(() => {
		const element = contentRef.current
		if (!element) {
			setIsTruncated(false)
			return
		}
		setIsTruncated(!isExpanded && element.scrollHeight > element.clientHeight)
	}, [markdown, isExpanded])

	if (!markdown) {
		return null
	}

	return (
		<div className="inline-block mb-2 description">
			<div className="relative wrap-anywhere overflow-y-hidden">
				<div
					className={cn("overflow-hidden text-sm [&>p]:m-0", {
						"line-clamp-none": isExpanded,
						"line-clamp-3 max-h-19": !isExpanded,
					})}
					ref={contentRef}>
					<ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
				</div>
				{isTruncated && (
					<div className="absolute bottom-0 right-0 flex items-center">
						<div className="w-10 h-5 bg-linear-to-r from-transparent to-sidebar-background" />
						<Button
							className={cn("bg-sidebar-background p-0 m-0 text-sm cursor-pointer", {
								"bg-code-block-background": isPopup,
							})}
							onClick={() => setIsExpanded(!isExpanded)}
							variant="link">
							{isExpanded ? "See less" : "See more"}
						</Button>
					</div>
				)}
			</div>
		</div>
	)
})
ModelDescriptionMarkdown.displayName = "ModelDescriptionMarkdown"
