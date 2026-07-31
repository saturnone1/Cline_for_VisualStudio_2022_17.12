import { ChevronDownIcon, ChevronRightIcon } from "lucide-react"
import React, { memo, useCallback, useMemo, useState } from "react"
import { formatLargeNumber as formatTokenNumber } from "@/utils/format"

interface TokenUsageInfoProps {
	tokensIn?: number
	tokensOut?: number
	cacheWrites?: number
	cacheReads?: number
	language?: "en" | "ko"
}

interface TokenDetail {
	title: string
	value?: number
	icon: string
}

interface TaskContextWindowButtonsProps extends TokenUsageInfoProps {
	percentage: number
	tokenUsed: number
	contextWindow: number
	configuredContextWindow?: number
	compactionTriggerTokens?: number
	compactionTargetTokens?: number
	usageSource: "reported" | "estimated"
	autoCompactEnabled?: boolean
	language?: "en" | "ko"
}

// New accordion item component
const AccordionItem = memo<{
	title: string
	value: React.ReactNode
	isExpanded: boolean
	onToggle: (event?: React.MouseEvent) => void
	children?: React.ReactNode
}>(({ title, value, isExpanded, onToggle, children }) => {
	const handleClick = useCallback(
		(event: React.MouseEvent) => {
			event.preventDefault()
			event.stopPropagation()
			onToggle(event)
		},
		[onToggle],
	)

	return (
		<div className="flex flex-col w-full">
			<div
				className="flex justify-between items-center gap-1 cursor-pointer hover:bg-foreground/5 rounded p-0.5 transition-colors w-full"
				onClick={handleClick}>
				<div className="flex items-center gap-1">
					{isExpanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
					<div className="font-semibold">{title}</div>
				</div>
				<div className="text-muted-foreground">{value}</div>
			</div>
			{isExpanded && children && <div className="ml-5 my-1 text-xs text-muted-foreground">{children}</div>}
		</div>
	)
})
AccordionItem.displayName = "AccordionItem"

// Constants
const TOKEN_DETAILS_CONFIG: Omit<TokenDetail, "value">[] = [
	{ title: "Prompt Tokens", icon: "codicon-arrow-up" },
	{ title: "Completion Tokens", icon: "codicon-arrow-down" },
	{ title: "Cache Writes", icon: "codicon-arrow-left" },
	{ title: "Cache Reads", icon: "codicon-arrow-right" },
]

const TokenUsageDetails = memo<TokenUsageInfoProps>(({ tokensIn, tokensOut, cacheWrites, cacheReads, language = "en" }) => {
	const isKorean = language === "ko"
	const totalTokens = (tokensIn || 0) + (tokensOut || 0) + (cacheWrites || 0) + (cacheReads || 0)
	const contextTokenDetails = useMemo(() => {
		const values = [tokensIn, tokensOut, cacheWrites || 0, cacheReads || 0]
		return TOKEN_DETAILS_CONFIG.map((config, index) => ({ ...config, value: values[index] })).filter((item) => item.value)
	}, [tokensIn, tokensOut, cacheWrites, cacheReads])

	if (totalTokens <= 0) {
		return <div>{isKorean ? "토큰 사용량 정보가 없습니다" : "No token usage data available"}</div>
	}

	return (
		<div className="space-y-1">
			{contextTokenDetails.map((item) => (
				<div className="flex justify-between" key={item.title}>
					<span>{isKorean ? ({ "Prompt Tokens": "입력 토큰", "Completion Tokens": "출력 토큰", "Cache Writes": "캐시 쓰기", "Cache Reads": "캐시 읽기" }[item.title] ?? item.title) : item.title}</span>
					<span className="font-mono">{formatTokenNumber(item.value || 0)}</span>
				</div>
			))}
		</div>
	)
})
TokenUsageDetails.displayName = "TokenUsageDetails"

export const ContextWindowSummary: React.FC<TaskContextWindowButtonsProps> = ({
	contextWindow,
	tokenUsed,
	tokensIn,
	tokensOut,
	cacheWrites,
	cacheReads,
	percentage,
	configuredContextWindow,
	compactionTriggerTokens,
	compactionTargetTokens,
	usageSource,
	autoCompactEnabled = false,
	language = "en",
}) => {
	// Accordion state
	const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set())

	const toggleSection = useCallback((section: string, event?: React.MouseEvent) => {
		if (event) {
			event.preventDefault()
			event.stopPropagation()
		}
		setExpandedSections((prev) => {
			const newSet = new Set(prev)
			if (newSet.has(section)) {
				newSet.delete(section)
			} else {
				newSet.add(section)
			}
			return newSet
		})
	}, [])

	const totalTokens = (tokensIn || 0) + (tokensOut || 0) + (cacheWrites || 0) + (cacheReads || 0)
	const isKorean = language === "ko"
	const hasDistinctConfiguredWindow = Boolean(configuredContextWindow && configuredContextWindow !== contextWindow)

	return (
		<div className="context-window-tooltip-content flex flex-col gap-2 bg-menu rounded shadow-sm z-100 w-60 p-1">
			{autoCompactEnabled && (
				<div className="rounded border border-[var(--vscode-widget-border)] p-1 text-xs text-muted-foreground">
					{isKorean
						? "SDK 자동 압축이 켜져 있습니다. 모델 요청 전에 전체 요청 크기를 검사해 필요할 때 압축합니다."
						: "SDK auto compaction is enabled. The full request is checked and compacted before model calls when needed."}
				</div>
			)}

			<AccordionItem
				isExpanded={expandedSections.has("context")}
				onToggle={(event) => toggleSection("context", event)}
				title={isKorean ? "컨텍스트 창" : "Context Window"}
				value={percentage ? `${percentage.toFixed(1)}%` : formatTokenNumber(contextWindow)}>
				<div className="space-y-1">
					<div className="flex justify-between">
						<span>{isKorean ? "사용량:" : "Used:"}</span>
						<span className="font-mono">{formatTokenNumber(tokenUsed)}</span>
					</div>
					<div className="flex justify-between">
						<span>{hasDistinctConfiguredWindow ? (isKorean ? "SDK 입력 한도:" : "SDK input limit:") : (isKorean ? "최대:" : "Total:")}</span>
						<span className="font-mono">{formatTokenNumber(contextWindow)}</span>
					</div>
					{hasDistinctConfiguredWindow && (
						<div className="flex justify-between">
							<span>{isKorean ? "설정된 모델 컨텍스트:" : "Configured model context:"}</span>
							<span className="font-mono">{formatTokenNumber(configuredContextWindow || 0)}</span>
						</div>
					)}
					{compactionTriggerTokens !== undefined && (
						<div className="flex justify-between">
							<span>{isKorean ? "자동 압축 기준:" : "Auto-compaction trigger:"}</span>
							<span className="font-mono">{formatTokenNumber(compactionTriggerTokens)}</span>
						</div>
					)}
					{compactionTargetTokens !== undefined && (
						<div className="flex justify-between">
							<span>{isKorean ? "압축 목표:" : "Compaction target:"}</span>
							<span className="font-mono">{formatTokenNumber(compactionTargetTokens)}</span>
						</div>
					)}
					<div className="flex justify-between">
						<span>{isKorean ? "남음:" : "Remaining:"}</span>
						<span className="font-mono">{formatTokenNumber(Math.max(0, contextWindow - tokenUsed))}</span>
					</div>
					<div className="flex justify-between">
						<span>{isKorean ? "출처:" : "Source:"}</span>
						<span>{usageSource === "reported" ? (isKorean ? "보고됨" : "Reported") : isKorean ? "추정됨" : "Estimated"}</span>
					</div>
				</div>
			</AccordionItem>

			{totalTokens > 0 && (
				<AccordionItem
					isExpanded={expandedSections.has("tokens")}
					onToggle={(event) => toggleSection("tokens", event)}
					title={isKorean ? "토큰 사용량" : "Token usage"}
					value={`${formatTokenNumber(totalTokens)}`}>
					<TokenUsageDetails
						cacheReads={cacheReads}
						cacheWrites={cacheWrites}
						language={language}
						tokensIn={tokensIn}
						tokensOut={tokensOut}
					/>
				</AccordionItem>
			)}
		</div>
	)
}
