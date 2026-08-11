import debounce from "debounce"
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/HoverCard"
import { Progress } from "@/components/ui/progress"
import { formatLargeNumber as formatTokenNumber } from "@/utils/format"
import { ContextWindowSummary } from "./ContextWindowSummary"

// Type definitions
interface ContextWindowInfoProps {
	tokensIn?: number
	tokensOut?: number
	cacheWrites?: number
	cacheReads?: number
	size?: number
}

interface ContextWindowProgressProps extends ContextWindowInfoProps {
	useAutoCondense: boolean
	lastApiReqTotalTokens?: number
	contextUsage?: {
		used: number
		source: "reported" | "estimated"
		reliable: boolean
		sdkMaxInputTokens?: number
		sdkCompactionTriggerTokens?: number
		sdkCompactionTargetTokens?: number
	}
	contextWindow?: number
	compactionInProgress?: boolean
	language?: "en" | "ko"
}

const ContextWindow: React.FC<ContextWindowProgressProps> = ({
	contextWindow = 0,
	contextUsage,
	compactionInProgress = false,
	lastApiReqTotalTokens = 0,
	language = "en",
	useAutoCondense,
	tokensIn,
	tokensOut,
	cacheWrites,
	cacheReads,
}) => {
	const [isOpened, setIsOpened] = useState(false)
	const progressBarRef = useRef<HTMLDivElement>(null)
	const isKorean = language === "ko"

	const tokenData = useMemo(() => {
		const used = contextUsage?.used || lastApiReqTotalTokens
		const effectiveLimit = contextUsage?.sdkMaxInputTokens || contextWindow
		if (effectiveLimit <= 0 || used <= 0) {
			return null
		}
		const percentage = (used / effectiveLimit) * 100
		return {
			cappedPercentage: Math.min(100, percentage),
			percentage,
			max: effectiveLimit,
			configuredMax: contextWindow,
			trigger: contextUsage?.sdkCompactionTriggerTokens,
			target: contextUsage?.sdkCompactionTargetTokens,
			used,
			source: contextUsage?.source ?? "reported",
		}
	}, [
		contextUsage?.sdkCompactionTargetTokens,
		contextUsage?.sdkCompactionTriggerTokens,
		contextUsage?.sdkMaxInputTokens,
		contextUsage?.source,
		contextUsage?.used,
		contextWindow,
		lastApiReqTotalTokens,
	])

	const closeHover = useMemo(() => debounce(() => setIsOpened(false), 100), [])

	useEffect(() => () => closeHover.clear(), [closeHover])

	const debounceCloseHover = useCallback((e: React.MouseEvent) => {
		e.preventDefault()
		e.stopPropagation()
		closeHover()
	}, [closeHover])

	const handleFocus = useCallback(() => {
		setIsOpened(true)
	}, [])

	// Close tooltip when clicking outside
	useEffect(() => {
		const handleClickOutside = (event: MouseEvent) => {
			const target = event.target as Element
			const isInsideProgressBar = progressBarRef.current?.contains(target as Node)

			// Check if click is inside any tooltip content by looking for our custom class
			const isInsideTooltipContent = target.closest(".context-window-tooltip-content") !== null

			if (!isInsideProgressBar && !isInsideTooltipContent) {
				setIsOpened(false)
			}
		}

		if (isOpened) {
			document.addEventListener("mousedown", handleClickOutside)
			return () => document.removeEventListener("mousedown", handleClickOutside)
		}
	}, [isOpened])

	if (!tokenData) {
		return null
	}

	const usageStatus =
		tokenData.percentage >= 100
			? isKorean
				? "한도 초과 가능"
				: "Limit may be exceeded"
			: useAutoCondense && tokenData.trigger
				? isKorean
					? `SDK 압축 기준 ${((tokenData.trigger / tokenData.max) * 100).toFixed(1)}%`
					: `SDK compaction at ${((tokenData.trigger / tokenData.max) * 100).toFixed(1)}%`
				: useAutoCondense
				? isKorean
					? "SDK 자동 압축 사용"
					: "SDK auto compaction enabled"
				: tokenData.source === "estimated"
					? isKorean
						? "추정 사용량"
						: "Estimated usage"
					: isKorean
						? "보고된 사용량"
						: "Reported usage"
	const indicatorClassName =
		tokenData.percentage >= 100
			? "bg-error"
			: "bg-success"

	return (
		<div className="flex flex-col my-1.5" onMouseLeave={debounceCloseHover}>
			<div className="flex gap-1 flex-row @max-xs:flex-col @max-xs:items-start items-center text-sm">
				<div className="flex items-center gap-1.5 flex-1 whitespace-nowrap">
					<span className="cursor-pointer text-sm" title={isKorean ? "현재 대화의 컨텍스트 사용량" : "Context usage for the current conversation"}>
						{formatTokenNumber(tokenData.used)}
					</span>
					<div className="flex relative items-center gap-1 flex-1 w-full h-full" onMouseEnter={() => setIsOpened(true)}>
						<HoverCard>
							<HoverCardContent className="bg-menu rounded-xs shadow-sm">
								<ContextWindowSummary
									autoCompactEnabled={useAutoCondense}
									cacheReads={cacheReads}
									cacheWrites={cacheWrites}
									configuredContextWindow={tokenData.configuredMax}
									contextWindow={tokenData.max}
									compactionTargetTokens={tokenData.target}
									compactionTriggerTokens={tokenData.trigger}
									language={language}
									percentage={tokenData.percentage}
									tokensIn={tokensIn}
									tokensOut={tokensOut}
									tokenUsed={tokenData.used}
									usageSource={tokenData.source}
								/>
							</HoverCardContent>
							<HoverCardTrigger asChild>
								{/* TODO: Re-add role="slider", aria-value*, onKeyDown, onClick, and tabIndex
								    when click-to-set-threshold is implemented. See PR #9348 for context. */}
								<div
									className="relative w-full text-foreground context-window-progress brightness-100"
									onFocus={handleFocus}
									ref={progressBarRef}>
									<Progress
									aria-label={isKorean ? "컨텍스트 창 사용량" : "Context window usage progress"}
										indicatorClassName={indicatorClassName}
										value={tokenData.cappedPercentage}
									/>
									{isOpened}
								</div>
							</HoverCardTrigger>
						</HoverCard>
					</div>
					<span className="cursor-pointer text-sm" title={contextUsage?.sdkMaxInputTokens
						? (isKorean ? "SDK가 보고한 실제 입력 한도" : "Effective input limit reported by the SDK")
						: (isKorean ? "설정된 최대 컨텍스트 창" : "Configured maximum context window")}>
						{formatTokenNumber(tokenData.max)}
					</span>
				</div>
				<span className="text-xs text-muted-foreground whitespace-nowrap">{`${tokenData.percentage.toFixed(1)}% · ${usageStatus}`}</span>
			</div>
			{compactionInProgress && (
				<div className="mt-1 rounded border border-[var(--vscode-widget-border)] px-2 py-1 text-xs text-muted-foreground">
					{isKorean ? "SDK가 컨텍스트를 자동으로 압축하는 중입니다..." : "The SDK is automatically compacting context..."}
				</div>
			)}
		</div>
	)
}

export default memo(ContextWindow)
