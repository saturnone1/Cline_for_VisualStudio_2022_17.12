import { ChevronDownIcon, ChevronRightIcon } from "lucide-react"
import { memo, useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface ThinkingRowProps {
	showTitle: boolean
	reasoningContent?: string
	isVisible: boolean
	isExpanded: boolean
	onToggle?: () => void
	title?: string
	isStreaming?: boolean
	showChevron?: boolean
}

function isPlaceholderContent(value: string | undefined) {
	const trimmed = (value || "").trim()
	return trimmed === "{}" || trimmed === "[]" || trimmed === "null" || trimmed === "undefined"
}

function isCompletedProgressTitle(value: string | undefined) {
	const normalized = (value || "").trim().toLowerCase()
	return (
		normalized === "파일/도구 처리 기록" ||
		normalized === "파일 읽기 기록" ||
		normalized === "터미널 실행 기록" ||
		normalized === "검색 기록" ||
		normalized === "응답 준비 기록" ||
		normalized === "reading files and using tools history" ||
		normalized === "running terminal history" ||
		normalized === "preparing response history" ||
		normalized === "model progress history" ||
		normalized === "모델 진행 기록"
	)
}

export const ThinkingRow = memo(
	({
		showTitle = false,
		reasoningContent,
		isVisible,
		isExpanded,
		onToggle,
		title = "Thinking",
		isStreaming = false,
		showChevron = true,
	}: ThinkingRowProps) => {
		const safeReasoningContent = isPlaceholderContent(reasoningContent) ? "" : reasoningContent
		const scrollRef = useRef<HTMLDivElement>(null)
		const [canScrollUp, setCanScrollUp] = useState(false)
		const [canScrollDown, setCanScrollDown] = useState(false)

		const checkScrollable = useCallback(() => {
			if (scrollRef.current) {
				const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
				setCanScrollUp(scrollTop > 1)
				setCanScrollDown(scrollTop + clientHeight < scrollHeight - 1)
			}
		}, [])

		useEffect(() => {
			if (scrollRef.current && isVisible && isExpanded && isStreaming) {
				scrollRef.current.scrollTop = scrollRef.current.scrollHeight
			}
			checkScrollable()
		}, [safeReasoningContent, isVisible, isExpanded, isStreaming, checkScrollable])

		if (!isVisible) {
			return null
		}

		if (!isStreaming && !safeReasoningContent?.trim() && isCompletedProgressTitle(title)) {
			return null
		}

		// Don't render anything if collapsed and no title (nothing to show)
		if (!isExpanded && !showTitle) {
			return null
		}

		return (
			<div className="lig-thinking-row ml-0 pl-0 mb-0">
				{showTitle ? (
					<Button
						className={cn(
							"inline-flex justify-baseline gap-0.5 text-left select-none px-0 py-0 my-0 h-auto min-h-0 w-full text-description overflow-visible",
							{
								"cursor-pointer": !!onToggle,
								"cursor-default": !onToggle,
							},
						)}
						onClick={onToggle}
						size="icon"
						variant="icon">
						<span
							className={cn("text-[13px] leading-[1.2]", {
								"animate-shimmer bg-linear-90 from-foreground to-description bg-[length:200%_100%] bg-clip-text text-transparent":
									isStreaming,
								"select-none": isStreaming,
							})}>
							{title}
						</span>
						{showChevron &&
							(isExpanded ? (
								<ChevronDownIcon className="!size-1 text-description" />
							) : (
								<ChevronRightIcon className="!size-1 text-description" />
							))}
					</Button>
				) : null}

				{isExpanded && safeReasoningContent?.trim() && (
					<Button
						className={cn(
							"flex gap-0 overflow-hidden w-full min-w-0 max-h-0 opacity-0 items-baseline justify-baseline text-left !p-0 !pl-0",
							"disabled:cursor-text disabled:opacity-100",
							{
								"max-h-[200px] opacity-100": isVisible,
								"transition-[max-height] duration-[250ms] ease-[cubic-bezier(0.4,0,0.2,1)] [transition:max-height_250ms_cubic-bezier(0.4,0,0.2,1),opacity_150ms_ease-out]":
									isVisible,
							},
						)}
						disabled={!showTitle}
						onClick={onToggle}
						variant="text">
						<div className="relative flex-1">
							<div
								className={cn(
									"flex max-h-[150px] overflow-y-auto text-description leading-normal truncated whitespace-pre-wrap break-words pl-0 [scrollbar-width:thin] [direction:ltr]",
								)}
								onScroll={checkScrollable}
								ref={scrollRef}>
								<span className="pb-1 block text-sm leading-snug">{safeReasoningContent}</span>
							</div>
							{canScrollUp && (
								<div className="absolute top-0 left-0 right-0 h-6 pointer-events-none bg-gradient-to-b from-background to-transparent" />
							)}
							{canScrollDown && (
								<div className="absolute bottom-0 left-0 right-0 h-6 pointer-events-none bg-gradient-to-t from-background to-transparent" />
							)}
						</div>
					</Button>
				)}
			</div>
		)
	},
)

ThinkingRow.displayName = "ThinkingRow"
