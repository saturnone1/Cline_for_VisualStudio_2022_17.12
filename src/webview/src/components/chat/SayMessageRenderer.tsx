import {
	type ClineMessage,
	type ClineSayGenerateExplanation,
	type ClineSayGenerateExplanationComment,
	type ClineSayTool,
	COMPLETION_RESULT_CHANGES_FLAG,
} from "@shared/ExtensionMessage"
import { BooleanRequest } from "@shared/proto/cline/common"
import type { Mode } from "@shared/storage/types"
import {
	ArrowRightIcon,
	BellIcon,
	CheckIcon,
	CircleSlashIcon,
	CircleXIcon,
	LightbulbIcon,
	LoaderCircleIcon,
	RefreshCwIcon,
	SettingsIcon,
	TriangleAlertIcon,
} from "lucide-react"
import type { MouseEvent, ReactNode, RefObject } from "react"
import { CheckmarkControl } from "@/components/common/CheckmarkControl"
import { WithCopyButton } from "@/components/common/CopyButton"
import McpResponseDisplay from "@/components/mcp/chatDisplay/McpResponseDisplay"
import { useI18n } from "@/i18n"
import { cn } from "@/lib/utils"
import { UiServiceClient } from "@/services/grpcClient"
import CodeAccordian, { cleanPathPrefix } from "../common/CodeAccordian"
import { CommandOutputContent } from "./CommandOutputRow"
import { CompletionOutputRow } from "./CompletionOutputRow"
import ErrorRow from "./ErrorRow"
import { FeatureTip } from "./FeatureTip"
import HookMessage from "./HookMessage"
import { MarkdownRow } from "./MarkdownRow"
import QuoteButton from "./QuoteButton"
import { RequestStartRow } from "./RequestStartRow"
import SubagentStatusRow from "./SubagentStatusRow"
import { ThinkingRow } from "./ThinkingRow"
import UserMessage from "./UserMessage"
import type { QuoteButtonState } from "./useQuoteSelection"
import { VsCommandOutputCard } from "./VsHostCards"

const HEADER_CLASSNAMES = "flex items-center gap-2.5 mb-3"
const InvisibleSpacer = () => <div aria-hidden className="h-px" />
const ProgressIndicator = () => <LoaderCircleIcon className="size-2 mr-2 animate-spin" />

export function getProgressRowTitle(content: string, isStreaming: boolean) {
	const normalized = content.trim()
	if (!normalized) return ""
	if (normalized.startsWith("터미널 실행 진행 중") || normalized.startsWith("터미널 실행 완료")) {
		return isStreaming ? "터미널 실행 진행 중" : "터미널 실행 기록"
	}
	if (normalized.includes("파일 읽기 진행 중") || normalized.includes("LIG VS가 파일") || normalized.startsWith("LIG VS read")) {
		return isStreaming ? "파일 읽기 진행 중" : "파일 읽기 기록"
	}
	if (normalized.includes("performed") || normalized.includes("Searches:")) return isStreaming ? "검색 진행 중" : "검색 기록"
	if (normalized.includes("prepared") || normalized.includes("Edits:")) return isStreaming ? "파일 편집 준비 중" : "파일 편집 기록"
	return ""
}

export function isEmptyJsonPlaceholder(value: string | undefined) {
	return ["{}", "[]", "null", "undefined"].includes((value || "").trim())
}

export function isCompletedProgressTitle(value: string | undefined) {
	return [
		"파일/도구 처리 기록",
		"파일 읽기 기록",
		"터미널 실행 기록",
		"검색 기록",
		"응답 준비 기록",
		"reading files and using tools history",
		"running terminal history",
		"preparing response history",
	].includes((value || "").trim().toLowerCase())
}

interface SayMessageRendererProps {
	message: ClineMessage
	lastModifiedMessage?: ClineMessage
	isLast: boolean
	isExpanded: boolean
	handleToggle: () => void
	mode?: Mode
	cost?: number
	apiRequestFailedMessage?: string
	apiReqStreamingFailedMessage?: string
	showFeatureTips?: boolean
	sendMessageFromChatRow?: (text: string, images: string[], files: string[]) => void
	contentRef: RefObject<HTMLDivElement | null>
	handleMouseUp: (event: MouseEvent<HTMLDivElement>) => void
	quoteButtonState: QuoteButtonState
	handleQuoteClick: () => void
	seeNewChangesDisabled: boolean
	setSeeNewChangesDisabled: (value: boolean) => void
	explainChangesDisabled: boolean
	setExplainChangesDisabled: (value: boolean) => void
	vscodeTerminalExecutionMode?: string
	title: ReactNode
	icon: ReactNode
}

export function SayMessageRenderer({
	message,
	lastModifiedMessage,
	isLast,
	isExpanded,
	handleToggle,
	mode,
	cost,
	apiRequestFailedMessage,
	apiReqStreamingFailedMessage,
	showFeatureTips,
	sendMessageFromChatRow,
	contentRef,
	handleMouseUp,
	quoteButtonState,
	handleQuoteClick,
	seeNewChangesDisabled,
	setSeeNewChangesDisabled,
	explainChangesDisabled,
	setExplainChangesDisabled,
	vscodeTerminalExecutionMode,
	title,
	icon,
}: SayMessageRendererProps) {
	const { t } = useI18n()
	switch (message.say) {
		case "api_req_started":
			return (
				<RequestStartRow
					apiReqStreamingFailedMessage={apiReqStreamingFailedMessage}
					apiRequestFailedMessage={apiRequestFailedMessage}
					cost={cost}
					handleToggle={handleToggle}
					isExpanded={isExpanded}
					message={message}
					mode={mode}
				/>
			)
		case "api_req_finished":
			return <InvisibleSpacer /> // we should never see this message type
		case "mcp_server_response":
			return <McpResponseDisplay responseText={message.text || ""} />
		case "mcp_notification":
			return (
				<div className="flex items-start gap-2 py-2.5 px-3 bg-quote rounded-sm text-base text-foreground opacity-90 mb-2">
					<BellIcon className="mt-0.5 size-2 text-notification-foreground shrink-0" />
					<div className="break-words flex-1">
						<span className="font-medium">{t("mcp.notification")} </span>
						<span className="ph-no-capture">{message.text}</span>
					</div>
				</div>
			)
		case "command_output":
			return <VsCommandOutputCard isExpanded={isExpanded} message={message} onToggle={handleToggle} />
		case "text": {
			return (
				<WithCopyButton
					onMouseUp={handleMouseUp}
					position="bottom-right"
					ref={contentRef}
					textToCopy={message.text}>
					<div className="lig-assistant-message flex items-center">
						<div className={cn("flex-1 min-w-0 pl-1")}>
							<MarkdownRow markdown={message.text} showCursor={false} />
						</div>
					</div>
					{quoteButtonState.visible && (
						<QuoteButton
							left={quoteButtonState.left}
							onClick={handleQuoteClick}
							top={quoteButtonState.top}
						/>
					)}
				</WithCopyButton>
			)
		}
		case "reasoning": {
			const isReasoningStreaming = message.partial === true
			const rawReasoningContent = message.reasoning || message.text || ""
			const reasoningContent = isEmptyJsonPlaceholder(rawReasoningContent) ? "" : rawReasoningContent
			const hasReasoningText = !!reasoningContent.trim()
			const contentTitle = getProgressRowTitle(reasoningContent, isReasoningStreaming)
			const titleFallback = isEmptyJsonPlaceholder(message.text) ? "" : message.text?.trim()
			if (!hasReasoningText && !isReasoningStreaming && (!titleFallback || isCompletedProgressTitle(titleFallback))) {
				return <InvisibleSpacer />
			}
			const title = contentTitle || titleFallback || (isReasoningStreaming ? "모델 진행 중" : "모델 진행 기록")
			return (
				<div className="lig-reasoning-row">
					<ThinkingRow
						isExpanded={isExpanded}
						isStreaming={isReasoningStreaming}
						isVisible={true}
						onToggle={hasReasoningText ? handleToggle : undefined}
						reasoningContent={reasoningContent}
						showChevron={hasReasoningText}
						showTitle={true}
						title={title}
					/>
					{isReasoningStreaming && showFeatureTips !== false && !hasReasoningText && <FeatureTip />}
				</div>
			)
		}
		case "user_feedback":
			return (
				<UserMessage
					files={message.files}
					images={message.images}
					messageTs={message.ts}
					sendMessageFromChatRow={sendMessageFromChatRow}
					text={message.text}
				/>
			)
		case "user_feedback_diff":
			const tool = JSON.parse(message.text || "{}") as ClineSayTool
			return (
				<div className="w-full -mt-2.5">
					<CodeAccordian
						diff={tool.diff!}
						isExpanded={isExpanded}
						isFeedback={true}
						onToggleExpand={handleToggle}
					/>
				</div>
			)
		case "error":
			return <ErrorRow errorType="error" message={message} />
		case "diff_error":
			return <ErrorRow errorType="diff_error" message={message} />
		case "clineignore_error":
			return <ErrorRow errorType="clineignore_error" message={message} />
		case "checkpoint_created":
			return <CheckmarkControl isCheckpointCheckedOut={message.isCheckpointCheckedOut} messageTs={message.ts} />
		case "load_mcp_documentation":
			return (
				<div className="text-foreground flex items-center opacity-70 text-[12px] py-1 px-0">
					<i className="codicon codicon-book mr-1.5" />
					Loading MCP documentation
				</div>
			)
		case "generate_explanation": {
			let explanationInfo: ClineSayGenerateExplanation = {
				title: "code changes",
				fromRef: "",
				toRef: "",
				status: "generating",
			}
			try {
				if (message.text) {
					explanationInfo = JSON.parse(message.text)
				}
			} catch {
				// Use defaults if parsing fails
			}
			// Check if generation was interrupted:
			// 1. If status is "generating" but this isn't the last message, it was interrupted
			// 2. If status is "generating" and lastModifiedMessage is a resume ask, task was just cancelled
			const wasCancelled =
				explanationInfo.status === "generating" &&
				(!isLast ||
					lastModifiedMessage?.ask === "resume_task" ||
					lastModifiedMessage?.ask === "resume_completed_task")
			const isGenerating = explanationInfo.status === "generating" && !wasCancelled
			const isError = explanationInfo.status === "error"
			const explanationComments = explanationInfo.comments ?? []
			const renderExplanationComment = (
				comment: ClineSayGenerateExplanationComment,
				index: number,
			) => (
				<div className="border border-editor-group-border rounded-sm px-2.5 py-2 mt-2" key={`${comment.filePath}:${comment.line}:${index}`}>
					<div className="text-xs opacity-70 break-all mb-1.5">
						{cleanPathPrefix(comment.filePath)}:{comment.line + 1}
					</div>
					<MarkdownRow markdown={comment.body} />
				</div>
			)
			return (
				<div className="bg-code flex flex-col border border-editor-group-border rounded-sm py-2.5 px-3">
					<div className="flex items-center">
						{isGenerating ? (
							<ProgressIndicator />
						) : isError ? (
							<CircleXIcon className="size-2 mr-2 text-error" />
						) : wasCancelled ? (
							<CircleSlashIcon className="size-2 mr-2" />
						) : (
							<CheckIcon className="size-2 mr-2 text-success" />
						)}
						<span className="font-semibold">
							{isGenerating
								? "Generating explanation"
								: isError
									? "Failed to generate explanation"
									: wasCancelled
										? "Explanation cancelled"
										: "Generated explanation"}
						</span>
					</div>
					{isError && explanationInfo.error && (
						<div className="opacity-80 ml-6 mt-1.5 text-error break-words">{explanationInfo.error}</div>
					)}
					{!isError && (explanationInfo.title || explanationInfo.fromRef) && (
						<div className="opacity-80 ml-6 mt-1.5">
							<div>{explanationInfo.title}</div>
							{explanationInfo.fromRef && (
								<div className="opacity-70 mt-1.5 break-all text-xs">
									<code className="bg-quote rounded-sm py-0.5 pr-1.5">
										{explanationInfo.fromRef}
									</code>
									<ArrowRightIcon className="inline size-2 mx-1" />
									<code className="bg-quote rounded-sm py-0.5 px-1.5">
										{explanationInfo.toRef || "working directory"}
									</code>
								</div>
							)}
							{explanationInfo.summary && (
								<div className="mt-2 text-sm text-foreground">
									<MarkdownRow markdown={explanationInfo.summary} />
								</div>
							)}
							{explanationComments.length > 0 && (
								<div className="mt-2">
									<div className="text-xs uppercase tracking-wide opacity-60">Comments</div>
									{explanationComments.map(renderExplanationComment)}
								</div>
							)}
						</div>
					)}
				</div>
			)
		}
		case "completion_result":
			const hasChanges = message.text?.endsWith(COMPLETION_RESULT_CHANGES_FLAG) ?? false
			const text = hasChanges ? message.text?.slice(0, -COMPLETION_RESULT_CHANGES_FLAG.length) : message.text

			if (!hasChanges) {
				return <div className="text-sm text-description py-0.5">{text || t("task.done")}</div>
			}

			return (
				<CompletionOutputRow
					explainChangesDisabled={explainChangesDisabled}
					handleQuoteClick={handleQuoteClick}
					headClassNames={HEADER_CLASSNAMES}
					messageTs={message.ts}
					quoteButtonState={quoteButtonState}
					seeNewChangesDisabled={seeNewChangesDisabled}
					setExplainChangesDisabled={setExplainChangesDisabled}
					setSeeNewChangesDisabled={setSeeNewChangesDisabled}
					showActionRow={message.partial !== true && hasChanges}
					text={text || ""}
				/>
			)
		case "shell_integration_warning":
			return (
				<div className="flex flex-col bg-warning/20 p-2 rounded-xs border border-error">
					<div className="flex items-center mb-1">
						<TriangleAlertIcon className="mr-2 size-2 stroke-3 text-error" />
						<span className="font-medium text-foreground">Shell Integration Unavailable</span>
					</div>
					<div className="text-foreground opacity-80">
						Cline may have trouble viewing the command's output. Please update VSCode (
						<code>CMD/CTRL + Shift + P</code> → "Update") and make sure you're using a supported shell:
						zsh, bash, fish, or PowerShell (<code>CMD/CTRL + Shift + P</code> → "Terminal: Select Default
						Profile").
						<a
							className="px-1"
							href="https://github.com/cline/cline/wiki/Troubleshooting-%E2%80%90-Shell-Integration-Unavailable">
							Still having trouble?
						</a>
					</div>
				</div>
			)
		case "error_retry":
			try {
				const retryInfo = JSON.parse(message.text || "{}")
				const { attempt, maxAttempts, delaySeconds, failed, errorMessage } = retryInfo
				const isFailed = failed === true

				return (
					<div className="flex flex-col gap-2">
						{errorMessage && (
							<p className="m-0 whitespace-pre-wrap text-error wrap-anywhere text-xs">{errorMessage}</p>
						)}
						<div className="flex flex-col bg-quote p-0 rounded-[3px] text-[12px] p-3">
							<div className="flex items-center mb-1">
								{isFailed ? (
									<TriangleAlertIcon className="mr-2 size-2" />
								) : (
									<RefreshCwIcon className="mr-2 size-2 animate-spin" />
								)}
								<span className="font-medium text-foreground">
									{isFailed ? "Auto-Retry Failed" : "Auto-Retry in Progress"}
								</span>
							</div>
							<div className="text-foreground opacity-80">
								{isFailed ? (
									<span>
										Auto-retry failed after <strong>{maxAttempts}</strong> attempts. Manual
										intervention required.
									</span>
								) : (
									<span>
										Attempt <strong>{attempt}</strong> of <strong>{maxAttempts}</strong> -
										Retrying in {delaySeconds} seconds...
									</span>
								)}
							</div>
						</div>
					</div>
				)
			} catch (_e) {
				// Fallback if JSON parsing fails
				return (
					<div className="text-foreground">
						<MarkdownRow markdown={message.text} />
					</div>
				)
			}
		case "hook_status":
			return <HookMessage CommandOutput={CommandOutputContent} message={message} />
		case "hook_output_stream":
			// hook_output_stream messages are combined with hook_status messages, so we don't render them separately
			return <InvisibleSpacer />
		case "subagent":
			return <SubagentStatusRow isLast={isLast} lastModifiedMessage={lastModifiedMessage} message={message} />
		case "shell_integration_warning_with_suggestion":
			const isBackgroundModeEnabled = vscodeTerminalExecutionMode === "backgroundExec"
			return (
				<div className="p-2 bg-link/10 border border-link/30 rounded-xs">
					<div className="flex items-center mb-1">
						<LightbulbIcon className="mr-1.5 size-2 text-link" />
						<span className="font-medium text-foreground">Shell integration issues</span>
					</div>
					<div className="text-foreground opacity-90 mb-2">
						Since you're experiencing repeated shell integration issues, we recommend switching to
						Background Terminal mode for better reliability.
					</div>
					<button
						className={cn(
							"bg-button-background text-button-foreground border-0 rounded-xs py-1.5 px-3 text-[12px] flex items-center gap-1.5 cursor-pointer hover:bg-button-hover",
							{
								"cursor-default opacity-80 bg-success": isBackgroundModeEnabled,
							},
						)}
						disabled={isBackgroundModeEnabled}
						onClick={async () => {
							try {
								// Enable background terminal execution mode
								await UiServiceClient.setTerminalExecutionMode(BooleanRequest.create({ value: true }))
							} catch (error) {
								console.error("Failed to enable background terminal:", error)
							}
						}}>
						<SettingsIcon className="size-2" />
						{isBackgroundModeEnabled
							? "Background Terminal Enabled"
							: "Enable Background Terminal (Recommended)"}
					</button>
				</div>
			)
		case "task_progress":
			return <InvisibleSpacer /> // task_progress messages should be displayed in TaskHeader only, not in chat
		default:
			return (
				<div>
					{title && (
						<div className={HEADER_CLASSNAMES}>
							{icon}
							{title}
						</div>
					)}
					<div className="pt-1">
						<MarkdownRow markdown={message.text} />
					</div>
				</div>
			)
	}
}
