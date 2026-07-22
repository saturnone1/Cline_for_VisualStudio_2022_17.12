import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import debounce from "debounce"
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/HoverCard"
import { Progress } from "@/components/ui/progress"
import { formatLargeNumber as formatTokenNumber } from "@/utils/format"
import CompactTaskButton from "./buttons/CompactTaskButton"
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
	}
	contextWindow?: number
	compactResetKey?: number
	compactionInProgress?: boolean
	compactThreshold?: number
	taskId?: string
	language?: "en" | "ko"
	onCompact?: () => Promise<void> | void
}

const ConfirmationDialog = memo<{
	onConfirm: (e: React.MouseEvent) => void
	onCancel: (e: React.MouseEvent) => void
	language: "en" | "ko"
}>(({ onConfirm, onCancel, language }) => (
	<div className="text-sm my-2 flex items-center gap-0 justify-between">
		<span className="font-semibold text-sm">{language === "ko" ? "현재 대화를 압축할까요?" : "Compact the current conversation?"}</span>
		<span className="flex gap-1">
			<VSCodeButton
				appearance="secondary"
				className="text-sm"
				onClick={onCancel}
				title={language === "ko" ? "압축하지 않기" : "Keep the conversation as is"}
				type="button">
				{language === "ko" ? "취소" : "Cancel"}
			</VSCodeButton>
			<VSCodeButton
				appearance="primary"
				autoFocus={true}
				className="text-sm"
				onClick={onConfirm}
				title={language === "ko" ? "대화 압축하기" : "Compact the conversation"}
				type="button">
				{language === "ko" ? "예" : "Yes"}
			</VSCodeButton>
		</span>
	</div>
))
ConfirmationDialog.displayName = "ConfirmationDialog"

const ContextWindow: React.FC<ContextWindowProgressProps> = ({
	contextWindow = 0,
	contextUsage,
	compactResetKey,
	compactionInProgress = false,
	compactThreshold = 90,
	lastApiReqTotalTokens = 0,
	language = "en",
	onCompact,
	taskId,
	useAutoCondense,
	tokensIn,
	tokensOut,
	cacheWrites,
	cacheReads,
}) => {
	const [isOpened, setIsOpened] = useState(false)
	const [confirmationNeeded, setConfirmationNeeded] = useState(false)
	const [autoCompactSuppressed, setAutoCompactSuppressed] = useState(false)
	const [isCompacting, setIsCompacting] = useState(false)
	const progressBarRef = useRef<HTMLDivElement>(null)
	const isKorean = language === "ko"
	const normalizedCompactThreshold = Math.min(100, Math.max(1, compactThreshold))
	const compacting = isCompacting || compactionInProgress

	const handleCompactClick = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault()
			e.stopPropagation()
			if (compacting) {
				return
			}
			setConfirmationNeeded(!confirmationNeeded)
		},
		[confirmationNeeded, compacting],
	)

	const handleConfirm = useCallback(
		async (e: React.MouseEvent) => {
			e.preventDefault()
			e.stopPropagation()
			if (!onCompact) {
				setConfirmationNeeded(false)
				setIsCompacting(false)
				return
			}
			setConfirmationNeeded(false)
			setAutoCompactSuppressed(true)
			setIsCompacting(true)
			try {
				await onCompact()
				setIsCompacting(false)
			} catch (error) {
				console.error(error)
				setIsCompacting(false)
			}
		},
		[onCompact],
	)

	const handleCancel = useCallback((e: React.MouseEvent) => {
		e.preventDefault()
		e.stopPropagation()
		setConfirmationNeeded(false)
		setAutoCompactSuppressed(true)
	}, [])

	useEffect(() => {
		setConfirmationNeeded(false)
		setAutoCompactSuppressed(false)
		setIsCompacting(false)
	}, [taskId])

	useEffect(() => {
		if (compactResetKey !== undefined) {
			setConfirmationNeeded(false)
			setAutoCompactSuppressed(true)
			setIsCompacting(false)
		}
	}, [compactResetKey])

	const tokenData = useMemo(() => {
		const used = contextUsage?.used || lastApiReqTotalTokens
		if (contextWindow <= 0 || used <= 0) {
			return null
		}
		const percentage = (used / contextWindow) * 100
		return {
			cappedPercentage: Math.min(100, percentage),
			percentage,
			max: contextWindow,
			used,
			source: contextUsage?.source ?? "reported",
		}
	}, [contextUsage?.source, contextUsage?.used, contextWindow, lastApiReqTotalTokens])

	const shouldSuggestCompact =
		Boolean(tokenData) &&
		useAutoCondense &&
		!compacting &&
		!confirmationNeeded &&
		!autoCompactSuppressed &&
		(tokenData?.percentage ?? 0) >= normalizedCompactThreshold

	useEffect(() => {
		if (!tokenData || tokenData.percentage < normalizedCompactThreshold) {
			setAutoCompactSuppressed(false)
		}
	}, [normalizedCompactThreshold, tokenData])

	useEffect(() => {
		if (shouldSuggestCompact) {
			setConfirmationNeeded(true)
		}
	}, [shouldSuggestCompact])

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
			: tokenData.percentage >= normalizedCompactThreshold
				? isKorean
					? "압축 권장"
					: "Compact recommended"
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
			: tokenData.percentage >= normalizedCompactThreshold
				? "bg-warning"
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
									contextWindow={tokenData.max}
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
					<span className="cursor-pointer text-sm" title={isKorean ? "설정된 최대 컨텍스트 창" : "Configured maximum context window"}>
						{formatTokenNumber(tokenData.max)}
					</span>
				</div>
				<span className="text-xs text-muted-foreground whitespace-nowrap">{`${tokenData.percentage.toFixed(1)}% · ${usageStatus}`}</span>
				<CompactTaskButton disabled={compacting} language={language} onClick={handleCompactClick} showLabel />
			</div>
			{compacting && (
				<div className="mt-1 rounded border border-[var(--vscode-widget-border)] px-2 py-1 text-xs text-muted-foreground">
					{isKorean ? "컨텍스트 압축 중..." : "Compacting context..."}
				</div>
			)}
			{confirmationNeeded && !compacting && <ConfirmationDialog language={language} onCancel={handleCancel} onConfirm={handleConfirm} />}
		</div>
	)
}

export default memo(ContextWindow)
