import { COMMAND_OUTPUT_STRING } from "@shared/combineCommandSequences"
import {
	ClineApiReqInfo,
	ClineAskQuestion,
	ClineAskUseMcpServer,
	ClineMessage,
	ClineSayGenerateExplanationComment,
	ClinePlanModeResponse,
	ClineSayGenerateExplanation,
	ClineSayTool,
	COMPLETION_RESULT_CHANGES_FLAG,
} from "@shared/ExtensionMessage"
import { BooleanRequest, StringRequest } from "@shared/proto/cline/common"
import { Mode } from "@shared/storage/types"
import deepEqual from "fast-deep-equal"
import {
	ArrowRightIcon,
	BellIcon,
	CheckIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	CircleSlashIcon,
	CircleXIcon,
	FileCode2Icon,
	FilePlus2Icon,
	FoldVerticalIcon,
	ImageUpIcon,
	LightbulbIcon,
	Link2Icon,
	LoaderCircleIcon,
	PencilIcon,
	RefreshCwIcon,
	SearchIcon,
	SettingsIcon,
	SquareArrowOutUpRightIcon,
	SquareMinusIcon,
	TerminalIcon,
	TriangleAlertIcon,
	Undo2Icon,
} from "lucide-react"
import { MouseEvent, memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useSize } from "react-use"
import { OptionsButtons } from "@/components/chat/OptionsButtons"
import { CheckmarkControl } from "@/components/common/CheckmarkControl"
import { WithCopyButton } from "@/components/common/CopyButton"
import McpResponseDisplay from "@/components/mcp/chatDisplay/McpResponseDisplay"
import McpResourceRow from "@/components/mcp/configuration/tabs/installed/serverRow/McpResourceRow"
import McpToolRow from "@/components/mcp/configuration/tabs/installed/serverRow/McpToolRow"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useI18n } from "@/i18n"
import { cn } from "@/lib/utils"
import { FileServiceClient, UiServiceClient } from "@/services/grpcClient"
import { findMatchingResourceOrTemplate, getMcpServerDisplayName } from "@/utils/mcp"
import CodeAccordian, { cleanPathPrefix } from "../common/CodeAccordian"
import { CommandOutputContent, CommandOutputRow } from "./CommandOutputRow"
import { CompletionOutputRow } from "./CompletionOutputRow"
import { DiffEditRow } from "./DiffEditRow"
import ErrorRow from "./ErrorRow"
import { FeatureTip } from "./FeatureTip"
import HookMessage from "./HookMessage"
import { MarkdownRow } from "./MarkdownRow"
import NewTaskPreview from "./NewTaskPreview"
import PlanCompletionOutputRow from "./PlanCompletionOutputRow"
import QuoteButton from "./QuoteButton"
import ReportBugPreview from "./ReportBugPreview"
import { RequestStartRow } from "./RequestStartRow"
import SearchResultsDisplay from "./SearchResultsDisplay"
import SubagentStatusRow from "./SubagentStatusRow"
import { ThinkingRow } from "./ThinkingRow"
import UserMessage from "./UserMessage"

const HEADER_CLASSNAMES = "flex items-center gap-2.5 mb-3"

function getProgressRowTitle(content: string, isStreaming: boolean) {
	const normalized = content.trim()
	if (!normalized) {
		return ""
	}
	if (normalized.startsWith("터미널 실행 진행 중") || normalized.startsWith("터미널 실행 완료")) {
		return isStreaming ? "터미널 실행 진행 중" : "터미널 실행 기록"
	}
	if (normalized.includes("파일 읽기 진행 중") || normalized.includes("LIG VS가 파일") || normalized.startsWith("LIG VS read")) {
		return isStreaming ? "파일 읽기 진행 중" : "파일 읽기 기록"
	}
	if (normalized.includes("performed") || normalized.includes("Searches:")) {
		return isStreaming ? "검색 진행 중" : "검색 기록"
	}
	if (normalized.includes("prepared") || normalized.includes("Edits:")) {
		return isStreaming ? "파일 편집 준비 중" : "파일 편집 기록"
	}
	return ""
}

function isEmptyJsonPlaceholder(value: string | undefined) {
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
		normalized === "preparing response history"
	)
}

type VsClineChangedFile = {
	filePath: string
	beforePath: string
	afterPath: string
	action: string
	additions: number
	deletions: number
}

type VsCommandOutputSummary = {
	command: string
	commandId: string
	terminalId: string
	cwd?: string
	currentDirectory?: string
	status?: string
	background?: boolean
	hotProcess?: boolean
	attachable?: boolean
	proceedWhileRunning?: boolean
	exitCode?: number
	durationMs?: number
	stdout: string
	stderr: string
	stdoutTruncated: boolean
	stderrTruncated: boolean
}

const VsCommandOutputCard = memo(
	({
		message,
		isExpanded,
		onToggle,
	}: {
		message: ClineMessage
		isExpanded: boolean
		onToggle: () => void
	}) => {
		const { t, language } = useI18n()
		const commands = useMemo(() => parseVsCommandOutputSummary(message.text || ""), [message.text])
		const [actionMessage, setActionMessage] = useState("")
		const count = commands.length
		const runTerminalAction = useCallback(
			async (
				event: MouseEvent,
				action: "attachTerminalCommand" | "continueTerminalCommand" | "openTerminalPanel",
				command: VsCommandOutputSummary,
			) => {
				event.stopPropagation()
				try {
					const response = await (UiServiceClient as any)[action]?.({
						commandId: command.commandId,
						terminalId: command.terminalId,
					})
					setActionMessage(response?.message || (action === "attachTerminalCommand" ? "Attached to Visual Studio command output." : "Terminal action sent."))
				} catch (error) {
					setActionMessage(error instanceof Error ? error.message : "Terminal action failed.")
				}
			},
			[],
		)

		if (count === 0) {
			return (
				<div className="rounded-sm border border-editor-group-border bg-code overflow-hidden">
					<button
						className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-list-hover"
						onClick={onToggle}
						type="button">
						<TerminalIcon className="size-3 shrink-0 opacity-80" />
						<span className="font-semibold">{t("command.output")}</span>
						<div className="grow" />
						{isExpanded ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
					</button>
					{isExpanded && <pre className="m-0 p-3 text-xs whitespace-pre-wrap break-words max-h-64 overflow-auto">{message.text}</pre>}
				</div>
			)
		}

		const failed = commands.some((command) => command.exitCode !== undefined && command.exitCode !== 0)
		const running = commands.some((command) => command.background || command.attachable || command.status === "running")
		const proceedAvailable = commands.some((command) => command.proceedWhileRunning)
		const totalOutputLines = commands.reduce(
			(total, command) =>
				total +
				(command.stdout ? command.stdout.split(/\r?\n/).length : 0) +
				(command.stderr ? command.stderr.split(/\r?\n/).length : 0),
			0,
		)

		return (
			<div className="rounded-sm border border-editor-group-border bg-code overflow-hidden">
				<button
					className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-list-hover"
					onClick={onToggle}
					type="button">
					<TerminalIcon className={cn("size-3 shrink-0", failed ? "text-error" : running ? "text-editor-warning-foreground" : "text-success")} />
					<div className="min-w-0">
						<div className="font-semibold">
							{language === "ko" ? `${running ? "실행 중인 명령" : "실행한 명령"} ${count}개` : `${running ? "Running commands" : "Ran commands"} ${count}`}
						</div>
						<div className="text-xs opacity-70">
							{failed ? (language === "ko" ? "일부 명령 실패" : "Some commands failed") : running ? "Visual Studio command host session" : t("common.completed")}
							{totalOutputLines > 0 ? ` · ${totalOutputLines} output line${totalOutputLines > 1 ? "s" : ""}` : ""}
							{proceedAvailable ? ` · ${t("command.proceedAvailable")}` : ""}
						</div>
					</div>
					<div className="grow" />
					{running && (
						<span className="rounded-xs border border-editor-group-border px-2 py-1 text-xs opacity-80">
							{isExpanded ? t("command.viewingLive") : t("command.viewLive")}
						</span>
					)}
					{isExpanded ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
				</button>
				{isExpanded && (
					<div className="divide-y divide-editor-group-border/60">
						{commands.map((command, index) => (
							<div className="px-3 py-2" key={`${command.commandId || command.command}-${index}`}>
								<div className="flex items-center gap-2 text-xs opacity-80 mb-1.5">
									<span
										className={cn("inline-block size-2 rounded-full", {
											"bg-success": command.exitCode === 0,
											"bg-error": command.exitCode !== undefined && command.exitCode !== 0,
											"bg-description": command.exitCode === undefined,
										})}
									/>
									{command.commandId && <code>{command.commandId}</code>}
									{command.terminalId && <span className="truncate">{command.terminalId}</span>}
									{command.status && <span>{command.status}</span>}
									{command.exitCode !== undefined && <span>exit {command.exitCode}</span>}
									{command.durationMs !== undefined && <span>{formatDuration(command.durationMs)}</span>}
									{command.background && <span>background</span>}
									{command.hotProcess && <span>hot</span>}
									{command.attachable && <span>attachable</span>}
									{command.proceedWhileRunning && <span>{t("command.proceedAvailable")}</span>}
								</div>
								{(command.currentDirectory || command.cwd) && (
									<div className="text-xs opacity-70 mb-1.5 truncate">cwd {command.currentDirectory || command.cwd}</div>
								)}
								{(command.attachable || command.proceedWhileRunning) && (
									<div className="flex flex-wrap items-center gap-2 mb-2">
										{command.attachable && (
											<button
												className="inline-flex items-center gap-1 rounded-xs border border-editor-group-border px-2 py-1 text-xs hover:bg-list-hover"
												onClick={(event) => runTerminalAction(event, "attachTerminalCommand", command)}
												type="button">
												<SquareArrowOutUpRightIcon className="size-3" />
												Attach
											</button>
										)}
										{command.proceedWhileRunning && (
											<button
												className="inline-flex items-center gap-1 rounded-xs border border-editor-group-border px-2 py-1 text-xs hover:bg-list-hover"
												onClick={(event) => runTerminalAction(event, "continueTerminalCommand", command)}
												type="button">
												<ArrowRightIcon className="size-3" />
												Continue
											</button>
										)}
										<button
											className="inline-flex items-center gap-1 rounded-xs border border-editor-group-border px-2 py-1 text-xs hover:bg-list-hover"
											onClick={(event) => runTerminalAction(event, "openTerminalPanel", command)}
											type="button">
											<TerminalIcon className="size-3" />
											Open Output
										</button>
									</div>
								)}
								{actionMessage && <div className="text-xs opacity-70 mb-2">{actionMessage}</div>}
								<pre className="m-0 mb-2 rounded-xs border border-editor-group-border/60 px-2 py-1.5 text-xs whitespace-pre-wrap break-words">
									{command.command}
								</pre>
								{command.stdout && (
									<div className="mb-2">
										<div className="text-xs opacity-70 mb-1">stdout{command.stdoutTruncated ? " (truncated)" : ""}</div>
										<pre className="m-0 rounded-xs border border-editor-group-border/60 bg-code px-2 py-1.5 text-xs whitespace-pre-wrap break-words max-h-64 overflow-auto">
											{command.stdout}
										</pre>
									</div>
								)}
								{command.stderr && (
									<div>
										<div className="text-xs opacity-70 mb-1">stderr{command.stderrTruncated ? " (truncated)" : ""}</div>
										<pre className="m-0 rounded-xs border border-editor-group-border/60 bg-code px-2 py-1.5 text-xs whitespace-pre-wrap break-words max-h-64 overflow-auto">
											{command.stderr}
										</pre>
									</div>
								)}
							</div>
						))}
					</div>
				)}
			</div>
		)
	},
)

function parseVsCommandOutputSummary(text: string): VsCommandOutputSummary[] {
	const blocks = text
		.split(/\n{2,}(?=[^\n]+(?:\n|$))/)
		.map((block) => block.trim())
		.filter(Boolean)

	return blocks
		.map(parseVsCommandOutputBlock)
		.filter((command): command is VsCommandOutputSummary => !!command && !!command.command)
}

function parseVsCommandOutputBlock(block: string): VsCommandOutputSummary | null {
	const lines = block.split(/\r?\n/)
	const result: VsCommandOutputSummary = {
		command: "",
		commandId: "",
		terminalId: "",
		stdout: "",
		stderr: "",
		stdoutTruncated: false,
		stderrTruncated: false,
	}
	let section: "stdout" | "stderr" | null = null
	const stdoutLines: string[] = []
	const stderrLines: string[] = []

	for (const line of lines) {
		if (line === "stdout:") {
			section = "stdout"
			continue
		}
		if (line === "stderr:") {
			section = "stderr"
			continue
		}
		if (section === "stdout") {
			stdoutLines.push(line)
			continue
		}
		if (section === "stderr") {
			stderrLines.push(line)
			continue
		}

		if (line.startsWith("commandId=")) {
			result.commandId = line.slice("commandId=".length)
		} else if (line.startsWith("terminal=")) {
			result.terminalId = line.slice("terminal=".length)
		} else if (line.startsWith("cwd=")) {
			result.cwd = line.slice("cwd=".length)
		} else if (line.startsWith("currentDirectory=")) {
			result.currentDirectory = line.slice("currentDirectory=".length)
		} else if (line.startsWith("status=")) {
			result.status = line.slice("status=".length)
		} else if (line === "background=true") {
			result.background = true
		} else if (line === "hotProcess=true") {
			result.hotProcess = true
		} else if (line === "attachable=true") {
			result.attachable = true
		} else if (line === "proceedWhileRunning=true") {
			result.proceedWhileRunning = true
		} else if (line.startsWith("exitCode=")) {
			const value = Number.parseInt(line.slice("exitCode=".length), 10)
			if (Number.isFinite(value)) {
				result.exitCode = value
			}
		} else if (line.startsWith("durationMs=")) {
			const value = Number.parseInt(line.slice("durationMs=".length), 10)
			if (Number.isFinite(value)) {
				result.durationMs = value
			}
		} else if (line === "stdout truncated") {
			result.stdoutTruncated = true
		} else if (line === "stderr truncated") {
			result.stderrTruncated = true
		} else if (!result.command && line.trim()) {
			result.command = line
		}
	}

	result.stdout = stdoutLines.join("\n").trimEnd()
	result.stderr = stderrLines.join("\n").trimEnd()
	return result.command || result.commandId || result.stdout || result.stderr ? result : null
}

function formatDuration(durationMs: number) {
	if (durationMs < 1000) {
		return `${durationMs}ms`
	}
	return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)}s`
}

const VsClineChangedFilesCard = memo(({ tool }: { tool: ClineSayTool }) => {
	const [isReverting, setIsReverting] = useState(false)
	const files = Array.isArray(tool.files) ? (tool.files as VsClineChangedFile[]) : []
	const additions = typeof tool.additions === "number" ? tool.additions : files.reduce((sum, file) => sum + (file.additions || 0), 0)
	const deletions = typeof tool.deletions === "number" ? tool.deletions : files.reduce((sum, file) => sum + (file.deletions || 0), 0)
	const visibleFiles = files.slice(0, 8)
	const hiddenCount = Math.max(files.length - visibleFiles.length, 0)

	const openDiff = (file: VsClineChangedFile) => {
		FileServiceClient.openVsClineDiff({
			leftPath: file.beforePath,
			rightPath: file.afterPath || file.filePath,
			title: `LIG VS change: ${file.filePath.split(/[\\/]/).pop() || file.filePath}`,
		}).catch((err: unknown) => console.error("Failed to open LIG VS diff:", err))
	}

	const undoChanges = async () => {
		if (isReverting || files.length === 0) {
			return
		}
		setIsReverting(true)
		try {
			await FileServiceClient.revertVsClineChanges({ files })
		} catch (err: unknown) {
			console.error("Failed to undo LIG VS changes:", err)
		} finally {
			setIsReverting(false)
		}
	}

	if (files.length === 0) {
		return null
	}

	return (
		<div className="rounded-sm border border-editor-group-border bg-code overflow-hidden">
			<div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-editor-group-border">
				<div className="flex items-center gap-2 min-w-0">
					<PencilIcon className="size-3 shrink-0" />
					<div className="min-w-0">
						<div className="font-bold text-foreground">Edited {files.length} file{files.length > 1 ? "s" : ""}</div>
						<div className="text-xs">
							<span className="text-success">+{additions}</span>
							<span className="mx-1" />
							<span className="text-error">-{deletions}</span>
						</div>
					</div>
				</div>
				<div className="flex items-center gap-2 shrink-0">
					<button
						className="inline-flex items-center gap-1 rounded-sm border border-editor-group-border px-2 py-1 text-xs hover:text-link hover:border-link disabled:cursor-wait disabled:opacity-60"
						disabled={isReverting}
						onClick={undoChanges}
						type="button">
						<Undo2Icon className="size-2.5" />
						Undo
					</button>
					<button
						className="rounded-sm border border-editor-group-border px-2 py-1 text-xs hover:text-link hover:border-link"
						onClick={() => openDiff(files[0])}
						type="button">
						Review
					</button>
				</div>
			</div>
			<div className="divide-y divide-editor-group-border/60">
				{visibleFiles.map((file) => (
					<button
						className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-list-hover"
						key={`${file.beforePath}-${file.afterPath}-${file.filePath}`}
						onClick={() => openDiff(file)}
						type="button">
						<FileCode2Icon className="size-3 shrink-0 opacity-70" />
						<span className="flex-1 min-w-0 truncate">{cleanPathPrefix(file.filePath)}</span>
						<span className="text-success text-xs">+{file.additions || 0}</span>
						<span className="text-error text-xs">-{file.deletions || 0}</span>
						<SquareArrowOutUpRightIcon className="size-2 shrink-0 opacity-70" />
					</button>
				))}
				{hiddenCount > 0 && <div className="px-3 py-2 text-xs text-description">Show {hiddenCount} more file{hiddenCount > 1 ? "s" : ""} in the task log.</div>}
			</div>
		</div>
	)
})

const VsClineRevertedFilesCard = memo(({ tool }: { tool: ClineSayTool }) => {
	const extendedTool = tool as ClineSayTool & {
		files?: unknown
		skipped?: unknown
	}
	const files = Array.isArray(extendedTool.files)
		? extendedTool.files.map((file) => String(file)).filter(Boolean)
		: []
	const skipped = Array.isArray(extendedTool.skipped)
		? (extendedTool.skipped as Array<{ filePath?: string; reason?: string }>)
		: []

	return (
		<div className="rounded-sm border border-editor-group-border bg-code overflow-hidden">
			<div className="flex items-center gap-2 px-3 py-2 border-b border-editor-group-border">
				<Undo2Icon className="size-3 shrink-0" />
				<div className="font-bold text-foreground">파일 {files.length}개 되돌림</div>
			</div>
			<div className="px-3 py-2 text-xs text-description">
				<div>{tool.content || "LIG VS 변경사항을 되돌렸습니다."}</div>
				{files.length > 0 && (
					<ul className="mt-2 space-y-1">
						{files.slice(0, 8).map((file) => (
							<li className="truncate" key={file}>{cleanPathPrefix(file)}</li>
						))}
					</ul>
				)}
				{skipped.length > 0 && (
					<div className="mt-2 text-error">
						건너뜀 {skipped.length}개: {skipped.map((item) => cleanPathPrefix(item.filePath || "")).filter(Boolean).join(", ")}
					</div>
				)}
			</div>
		</div>
	)
})

interface ChatRowProps {
	message: ClineMessage
	isExpanded: boolean
	onToggleExpand: (ts: number) => void
	lastModifiedMessage?: ClineMessage
	isLast: boolean
	onHeightChange: (isTaller: boolean) => void
	inputValue?: string
	sendMessageFromChatRow?: (text: string, images: string[], files: string[]) => void
	onSetQuote: (text: string) => void
	onCancelCommand?: () => void
	mode?: Mode
}

export interface QuoteButtonState {
	visible: boolean
	top: number
	left: number
	selectedText: string
}

interface ChatRowContentProps extends Omit<ChatRowProps, "onHeightChange"> {}

export const ProgressIndicator = () => <LoaderCircleIcon className="size-2 mr-2 animate-spin" />
const InvisibleSpacer = () => <div aria-hidden className="h-px" />

const ChatRow = memo(
	(props: ChatRowProps) => {
		const { isLast, onHeightChange, message } = props
		// Store the previous height to compare with the current height
		// This allows us to detect changes without causing re-renders
		const prevHeightRef = useRef(0)

		const [chatrow, { height }] = useSize(
			<div className="relative pt-2.5 px-4">
				<ChatRowContent {...props} />
			</div>,
		)

		useEffect(() => {
			// used for partials command output etc.
			// NOTE: it's important we don't distinguish between partial or complete here since our scroll effects in chatview need to handle height change during partial -> complete
			const isInitialRender = prevHeightRef.current === 0 // prevents scrolling when new element is added since we already scroll for that
			// height starts off at Infinity
			if (isLast && height !== 0 && height !== Number.POSITIVE_INFINITY && height !== prevHeightRef.current) {
				if (!isInitialRender) {
					onHeightChange(height > prevHeightRef.current)
				}
				prevHeightRef.current = height
			}
		}, [height, isLast, onHeightChange, message])

		// we cannot return null as virtuoso does not support it so we use a separate visibleMessages array to filter out messages that should not be rendered
		return chatrow
	},
	// memo does shallow comparison of props, so we need to do deep comparison of arrays/objects whose properties might change
	deepEqual,
)

export default ChatRow

export const ChatRowContent = memo(
	({
		message,
		isExpanded,
		onToggleExpand,
		lastModifiedMessage,
		isLast,
		inputValue,
		sendMessageFromChatRow,
		onSetQuote,
		onCancelCommand,
		mode,
	}: ChatRowContentProps) => {
		const {
			backgroundEditEnabled,
			mcpServers,
			mcpMarketplaceCatalog,
			onRelinquishControl,
			vscodeTerminalExecutionMode,
			clineMessages,
			showFeatureTips,
		} = useExtensionState()
		const { t, language } = useI18n()
		const [seeNewChangesDisabled, setSeeNewChangesDisabled] = useState(false)
		const [explainChangesDisabled, setExplainChangesDisabled] = useState(false)
		const [quoteButtonState, setQuoteButtonState] = useState<QuoteButtonState>({
			visible: false,
			top: 0,
			left: 0,
			selectedText: "",
		})
		const contentRef = useRef<HTMLDivElement>(null)

		// Command output expansion state (for all messages, but only used by command messages)
		const [isOutputFullyExpanded, setIsOutputFullyExpanded] = useState(false)
		const prevCommandExecutingRef = useRef<boolean>(false)

		const hasAutoExpandedRef = useRef(false)
		const hasAutoCollapsedRef = useRef(false)
		const prevIsLastRef = useRef(isLast)

		// Auto-expand completion output when it's the last message (runs once per message)
		useEffect(() => {
			const isCompletionResult = message.ask === "completion_result" || message.say === "completion_result"

			// Auto-expand if it's last and we haven't already auto-expanded
			if (isLast && isCompletionResult && !hasAutoExpandedRef.current) {
				hasAutoExpandedRef.current = true
				hasAutoCollapsedRef.current = false // Reset the auto-collapse flag when expanding
			}
		}, [isLast, message.ask, message.say])

		// Auto-collapse completion output ONCE when transitioning from last to not-last
		useEffect(() => {
			const isCompletionResult = message.ask === "completion_result" || message.say === "completion_result"
			const wasLast = prevIsLastRef.current

			// Only auto-collapse if transitioning from last to not-last, and we haven't already auto-collapsed
			if (wasLast && !isLast && isCompletionResult && !hasAutoCollapsedRef.current) {
				hasAutoCollapsedRef.current = true
				hasAutoExpandedRef.current = false // Reset the auto-expand flag when collapsing
			}

			prevIsLastRef.current = isLast
		}, [isLast, message.ask, message.say])

		const [cost, apiReqCancelReason, apiReqStreamingFailedMessage] = useMemo(() => {
			if (message.text != null && message.say === "api_req_started") {
				const info: ClineApiReqInfo = JSON.parse(message.text)
				return [info.cost, info.cancelReason, info.streamingFailedMessage, info.retryStatus]
			}
			return [undefined, undefined, undefined, undefined, undefined]
		}, [message.text, message.say])

		// when resuming task last won't be api_req_failed but a resume_task message so api_req_started will show loading spinner. that's why we just remove the last api_req_started that failed without streaming anything
		const apiRequestFailedMessage =
			isLast && lastModifiedMessage?.ask === "api_req_failed" // if request is retried then the latest message is a api_req_retried
				? lastModifiedMessage?.text
				: undefined

		const type = message.type === "ask" ? message.ask : message.say

		const isCommandMessage = type === "command"
		// Check if command has output to determine if it's actually executing
		const commandHasOutput = message.text?.includes(COMMAND_OUTPUT_STRING) ?? false
		// A command is executing if it has output but hasn't completed yet
		const isCommandExecuting = isCommandMessage && !message.commandCompleted && commandHasOutput
		// A command is pending if it hasn't started (no output) and hasn't completed
		const isCommandPending = isCommandMessage && isLast && !message.commandCompleted && !commandHasOutput
		const isCommandCompleted = isCommandMessage && message.commandCompleted === true

		const isMcpServerResponding = isLast && lastModifiedMessage?.say === "mcp_server_request_started"

		const handleToggle = useCallback(() => {
			onToggleExpand(message.ts)
		}, [onToggleExpand, message.ts])

		// Use the onRelinquishControl hook instead of message event
		useEffect(() => {
			return onRelinquishControl(() => {
				setSeeNewChangesDisabled(false)
				setExplainChangesDisabled(false)
			})
		}, [onRelinquishControl])

		// --- Quote Button Logic ---
		// MOVE handleQuoteClick INSIDE ChatRowContent
		const handleQuoteClick = useCallback(() => {
			onSetQuote(quoteButtonState.selectedText)
			window.getSelection()?.removeAllRanges() // Clear the browser selection
			setQuoteButtonState({ visible: false, top: 0, left: 0, selectedText: "" })
		}, [onSetQuote, quoteButtonState.selectedText]) // <-- Use onSetQuote from props

		const handleMouseUp = useCallback((event: MouseEvent<HTMLDivElement>) => {
			// Get the target element immediately, before the timeout
			const targetElement = event.target as Element
			const isClickOnButton = !!targetElement.closest(".quote-button-class")

			// Delay the selection check slightly
			setTimeout(() => {
				// Now, check the selection state *after* the browser has likely updated it
				const selection = window.getSelection()
				const selectedText = selection?.toString().trim() ?? ""

				let shouldShowButton = false
				let buttonTop = 0
				let buttonLeft = 0
				let textToQuote = ""

				// Condition 1: Check if there's a valid, non-collapsed selection within bounds
				// Ensure contentRef.current still exists in case component unmounted during timeout
				if (selectedText && contentRef.current && selection && selection.rangeCount > 0 && !selection.isCollapsed) {
					const range = selection.getRangeAt(0)
					const rangeRect = range.getBoundingClientRect()
					// Re-check ref inside timeout and ensure containerRect is valid
					const containerRect = contentRef.current?.getBoundingClientRect()

					if (containerRect) {
						// Check if containerRect was successfully obtained
						const tolerance = 5 // Allow for a small pixel overflow (e.g., for margins)
						const isSelectionWithin =
							rangeRect.top >= containerRect.top &&
							rangeRect.left >= containerRect.left &&
							rangeRect.bottom <= containerRect.bottom + tolerance && // Added tolerance
							rangeRect.right <= containerRect.right

						if (isSelectionWithin) {
							shouldShowButton = true // Mark that we should show the button
							const buttonHeight = 30
							// Calculate the raw top position relative to the container, placing it above the selection
							const calculatedTop = rangeRect.top - containerRect.top - buttonHeight - 5 // Subtract button height and a small margin
							// Allow the button to potentially have a negative top value
							buttonTop = calculatedTop
							buttonLeft = Math.max(0, rangeRect.left - containerRect.left) // Still prevent going left of container
							textToQuote = selectedText
						}
					}
				}

				// Decision: Set the state based on whether we should show or hide
				if (shouldShowButton) {
					// Scenario A: Valid selection exists -> Show button
					setQuoteButtonState({
						visible: true,
						top: buttonTop,
						left: buttonLeft,
						selectedText: textToQuote,
					})
				} else if (!isClickOnButton) {
					// Scenario B: No valid selection AND click was NOT on button -> Hide button
					setQuoteButtonState({ visible: false, top: 0, left: 0, selectedText: "" })
				}
				// Scenario C (Click WAS on button): Do nothing here, handleQuoteClick takes over.
			}, 0) // Delay of 0ms pushes execution after current event cycle
		}, []) // Dependencies remain empty

		const [icon, title] = useMemo(() => {
			switch (type) {
				case "error":
					return [
						<span className="codicon codicon-error text-error mb-[-1.5px]" />,
						<span className="text-error font-bold">Error</span>,
					]
				case "mistake_limit_reached":
					return [
						<CircleXIcon className="text-error size-2" />,
						<span className="text-error font-bold">{language === "ko" ? "LIG VS가 문제를 처리하는 중입니다..." : "LIG VS is having trouble..."}</span>,
					]
				case "command":
					return [
						<TerminalIcon className="text-foreground size-2" />,
						<span className="font-bold text-foreground">{t("command.title")}</span>,
					]
				case "use_mcp_server":
					const mcpServerUse = JSON.parse(message.text || "{}") as ClineAskUseMcpServer
					return [
						isMcpServerResponding ? (
							<ProgressIndicator />
						) : (
							<span className="codicon codicon-server text-foreground mb-[-1.5px]" />
						),
						<span className="ph-no-capture font-bold text-foreground break-words">
							LIG VS가{" "}
							<code className="break-all">
								{getMcpServerDisplayName(mcpServerUse.serverName, mcpMarketplaceCatalog)}
							</code>{" "}
							MCP 서버에서 {mcpServerUse.type === "use_mcp_tool" ? "도구를 사용하려고 합니다:" : "리소스에 접근하려고 합니다:"}
						</span>,
					]
				case "completion_result":
					return [
						<span className="codicon codicon-check text-success mb-[-1.5px]" />,
						<span className="text-success font-bold">작업 완료</span>,
					]
				case "api_req_started":
					// API request rows no longer render the request payload/cost accordion.
					// Thinking/reasoning is handled directly in the api_req_started renderer below.
					return [null, null]
				case "followup":
					return [
						<span className="codicon codicon-question text-foreground mb-[-1.5px]" />,
						<span className="font-bold text-foreground">LIG VS 질문:</span>,
					]
				default:
					return [null, null]
			}
		}, [
			type,
			cost,
			apiRequestFailedMessage,
			isCommandExecuting,
			isCommandPending,
			apiReqCancelReason,
			isMcpServerResponding,
			message.text,
		])

		const tool = useMemo(() => {
			if (message.ask === "tool" || message.say === "tool") {
				return JSON.parse(message.text || "{}") as ClineSayTool
			}
			return null
		}, [message.ask, message.say, message.text])

		const conditionalRulesInfo = useMemo(() => {
			if (message.say !== "conditional_rules_applied" || !message.text) return null
			try {
				const parsed = JSON.parse(message.text) as unknown
				if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as any).rules)) {
					return null
				}
				return parsed as {
					rules: Array<{ name: string; matchedConditions: Record<string, string[]> }>
				}
			} catch {
				return null
			}
		}, [message.say, message.text])

		// Helper function to check if file is an image
		const isImageFile = (filePath: string): boolean => {
			const imageExtensions = [".png", ".jpg", ".jpeg", ".webp"]
			const extension = filePath.toLowerCase().split(".").pop()
			return extension ? imageExtensions.includes(`.${extension}`) : false
		}

		if (conditionalRulesInfo) {
			const names = conditionalRulesInfo.rules.map((r: { name: string }) => r.name).join(", ")
			return (
				<div className={HEADER_CLASSNAMES}>
					<span style={{ fontWeight: "bold" }}>Conditional rules applied:</span>
					<span className="ph-no-capture break-words whitespace-pre-wrap">{names}</span>
				</div>
			)
		}

		if (tool) {
			const colorMap = {
				red: "var(--vscode-errorForeground)",
				yellow: "var(--vscode-editorWarning-foreground)",
				green: "var(--vscode-charts-green)",
			}
			const toolIcon = (name: string, color?: string, rotation?: number, title?: string) => (
				<span
					className={`codicon codicon-${name} ph-no-capture`}
					style={{
						color: color ? colorMap[color as keyof typeof colorMap] || color : "var(--vscode-foreground)",
						marginBottom: "-1.5px",
						transform: rotation ? `rotate(${rotation}deg)` : undefined,
					}}
					title={title}
				/>
			)

			switch (String(tool.tool)) {
				case "vsclineChangedFiles":
					return <VsClineChangedFilesCard tool={tool} />
				case "vsclineRevertedFiles":
					return <VsClineRevertedFilesCard tool={tool} />
				case "editedExistingFile":
					const content = tool?.content || ""
					const isApplyingPatch = content?.startsWith("%%bash") && !content.endsWith("*** End Patch\nEOF")
					const editToolTitle = isApplyingPatch
						? t("tool.filePatch")
						: t("tool.fileEdit")
					return (
						<div>
							<div className={HEADER_CLASSNAMES}>
								<PencilIcon className="size-2" />
								{tool.operationIsLocatedInWorkspace === false &&
									toolIcon("sign-out", "yellow", -90, t("tool.outsideWorkspace.file"))}
								<span style={{ fontWeight: "bold" }}>{editToolTitle}</span>
							</div>
							{backgroundEditEnabled && tool.path && tool.content ? (
								<DiffEditRow
									isLoading={message.partial}
									patch={tool.content}
									path={tool.path}
									startLineNumbers={tool.startLineNumbers}
								/>
							) : (
								<CodeAccordian
									// isLoading={message.partial}
									code={tool.content}
									isExpanded={isExpanded}
									onToggleExpand={handleToggle}
									path={tool.path!}
								/>
							)}
						</div>
					)
				case "fileDeleted":
					return (
						<div>
							<div className={HEADER_CLASSNAMES}>
								<SquareMinusIcon className="size-2" />
								{tool.operationIsLocatedInWorkspace === false &&
									toolIcon("sign-out", "yellow", -90, t("tool.outsideWorkspace.file"))}
								<span style={{ fontWeight: "bold" }}>{t("tool.fileDelete")}</span>
							</div>
							<CodeAccordian
								// isLoading={message.partial}
								code={tool.content}
								isExpanded={isExpanded}
								onToggleExpand={handleToggle}
								path={tool.path!}
							/>
						</div>
					)
				case "newFileCreated":
					return (
						<div>
							<div className={HEADER_CLASSNAMES}>
								<FilePlus2Icon className="size-2" />
								{tool.operationIsLocatedInWorkspace === false &&
									toolIcon("sign-out", "yellow", -90, t("tool.outsideWorkspace.file"))}
								<span className="font-bold">{t("tool.fileCreate")}</span>
							</div>
							{backgroundEditEnabled && tool.path && tool.content ? (
								<DiffEditRow patch={tool.content} path={tool.path} startLineNumbers={tool.startLineNumbers} />
							) : (
								<CodeAccordian
									code={tool.content!}
									isExpanded={isExpanded}
									isLoading={message.partial}
									onToggleExpand={handleToggle}
									path={tool.path!}
								/>
							)}
						</div>
					)
				case "readFile":
					const isImage = isImageFile(tool.path || "")
					return (
						<div>
							<div className={HEADER_CLASSNAMES}>
								{isImage ? <ImageUpIcon className="size-2" /> : <FileCode2Icon className="size-2" />}
								{tool.operationIsLocatedInWorkspace === false &&
									toolIcon("sign-out", "yellow", -90, t("tool.outsideWorkspace.file"))}
								<span className="font-bold">{t("tool.fileRead")}</span>
							</div>
							<div className="bg-code rounded-sm overflow-hidden border border-editor-group-border">
								<div
									className={cn("text-description flex items-center cursor-pointer select-none py-2 px-2.5", {
										"cursor-default select-text": isImage,
									})}
									onClick={() => {
										if (!isImage) {
											FileServiceClient.openFile(StringRequest.create({ value: tool.content })).catch(
												(err) => console.error("Failed to open file:", err),
											)
										}
									}}>
									{tool.path?.startsWith(".") && <span>.</span>}
									{tool.path && !tool.path.startsWith(".") && <span>/</span>}
									<span className="ph-no-capture whitespace-nowrap overflow-hidden text-ellipsis mr-2 text-left [direction: rtl]">
										{cleanPathPrefix(tool.path ?? "") + "\u200E"}
										{tool.readLineStart != null && tool.readLineEnd != null ? (
											<span className="opacity-80">
												{" "}
												({tool.readLineStart}-{tool.readLineEnd})
											</span>
										) : null}
									</span>
									<div className="grow" />
									{!isImage && <SquareArrowOutUpRightIcon className="size-2" />}
								</div>
							</div>
						</div>
					)
				case "listFilesTopLevel":
					return (
						<div>
							<div className={HEADER_CLASSNAMES}>
								{toolIcon("folder-opened")}
									{tool.operationIsLocatedInWorkspace === false &&
									toolIcon("sign-out", "yellow", -90, t("tool.outsideWorkspace.path"))}
								<span style={{ fontWeight: "bold" }}>
									{message.type === "ask" ? t("tool.listTop.ask") : t("tool.listTop.done")}
								</span>
							</div>
							<CodeAccordian
								code={tool.content!}
								isExpanded={isExpanded}
								language="shell-session"
								onToggleExpand={handleToggle}
								path={tool.path!}
							/>
						</div>
					)
				case "listFilesRecursive":
					return (
						<div>
							<div className={HEADER_CLASSNAMES}>
								{toolIcon("folder-opened")}
									{tool.operationIsLocatedInWorkspace === false &&
									toolIcon("sign-out", "yellow", -90, t("tool.outsideWorkspace.path"))}
								<span style={{ fontWeight: "bold" }}>
									{message.type === "ask" ? t("tool.listRecursive.ask") : t("tool.listRecursive.done")}
								</span>
							</div>
							<CodeAccordian
								code={tool.content!}
								isExpanded={isExpanded}
								language="shell-session"
								onToggleExpand={handleToggle}
								path={tool.path!}
							/>
						</div>
					)
				case "listCodeDefinitionNames":
					return (
						<div>
							<div className={HEADER_CLASSNAMES}>
								{toolIcon("file-code")}
									{tool.operationIsLocatedInWorkspace === false &&
									toolIcon("sign-out", "yellow", -90, t("tool.outsideWorkspace.file"))}
								<span style={{ fontWeight: "bold" }}>
									{message.type === "ask" ? t("tool.definitions.ask") : t("tool.definitions.done")}
								</span>
							</div>
							<CodeAccordian
								code={tool.content!}
								isExpanded={isExpanded}
								onToggleExpand={handleToggle}
								path={tool.path!}
							/>
						</div>
					)
				case "searchFiles":
					return (
						<div>
							<div className={HEADER_CLASSNAMES}>
								{toolIcon("search")}
								{tool.operationIsLocatedInWorkspace === false &&
									toolIcon("sign-out", "yellow", -90, t("tool.outsideWorkspace.path"))}
								<span className="font-bold">
									{language === "ko" ? (
										<>
											LIG VS가 이 폴더에서 <code className="break-all">{tool.regex}</code> 항목을 검색하려고 합니다:
										</>
									) : (
										<>
											LIG VS wants to search this directory for <code className="break-all">{tool.regex}</code>:
										</>
									)}
								</span>
							</div>
							<SearchResultsDisplay
								content={tool.content!}
								filePattern={tool.filePattern}
								isExpanded={isExpanded}
								onToggleExpand={handleToggle}
								path={tool.path!}
							/>
						</div>
					)
				case "summarizeTask":
					return (
						<div>
							<div className={HEADER_CLASSNAMES}>
								<FoldVerticalIcon className="size-2" />
								<span className="font-bold">{t("tool.condensing")}</span>
							</div>
							<div className="bg-code overflow-hidden border border-editor-group-border rounded-[3px]">
								<div
									aria-label={language === "ko" ? (isExpanded ? "요약 접기" : "요약 펼치기") : isExpanded ? "Collapse summary" : "Expand summary"}
									className="text-description py-2 px-2.5 cursor-pointer select-none"
									onClick={handleToggle}
									onKeyDown={(e) => {
										if (e.key === "Enter" || e.key === " ") {
											e.preventDefault()
											e.stopPropagation()
											handleToggle()
										}
									}}
									tabIndex={0}>
									{isExpanded ? (
										<div>
											<div className="flex items-center mb-2">
												<span className="font-bold mr-1">{t("tool.summary")}</span>
												<div className="grow" />
												<ChevronDownIcon className="my-0.5 shrink-0 size-4" />
											</div>
											<span className="ph-no-capture break-words whitespace-pre-wrap">{tool.content}</span>
										</div>
									) : (
										<div className="flex items-center">
											<span className="ph-no-capture whitespace-nowrap overflow-hidden text-ellipsis text-left flex-1 mr-2 [direction:rtl]">
												{tool.content + "\u200E"}
											</span>
											<ChevronRightIcon className="my-0.5 shrink-0 size-4" />
										</div>
									)}
								</div>
							</div>
						</div>
					)
				case "webFetch":
					return (
						<div>
							<div className={HEADER_CLASSNAMES}>
								<Link2Icon className="size-2" />
								{tool.operationIsLocatedInWorkspace === false &&
									toolIcon("sign-out", "yellow", -90, language === "ko" ? "외부 URL입니다" : "This URL is external")}
								<span className="font-bold">
									{message.type === "ask" ? t("tool.webFetch.ask") : t("tool.webFetch.done")}
								</span>
							</div>
							<div
								className="bg-code rounded-xs overflow-hidden border border-editor-group-border py-2 px-2.5 cursor-pointer select-none"
								onClick={() => {
									// Open the URL in the default browser using gRPC
									if (tool.path) {
										UiServiceClient.openUrl(StringRequest.create({ value: tool.path })).catch((err) => {
											console.error("Failed to open URL:", err)
										})
									}
								}}>
								<span className="ph-no-capture whitespace-nowrap overflow-hidden text-ellipsis mr-2 [direction:rtl] text-left text-link underline">
									{tool.path + "\u200E"}
								</span>
							</div>
						</div>
					)
				case "webSearch":
					return (
						<div>
							<div className={HEADER_CLASSNAMES}>
								<SearchIcon className="size-2 rotate-90" />
								{tool.operationIsLocatedInWorkspace === false &&
									toolIcon("sign-out", "yellow", -90, language === "ko" ? "외부 검색입니다" : "This search is external")}
								<span className="font-bold">
									{message.type === "ask" ? t("tool.webSearch.ask") : t("tool.webSearch.done")}
								</span>
							</div>
							<div className="bg-code border border-editor-group-border overflow-hidden rounded-xs select-text py-[9px] px-2.5">
								<span className="ph-no-capture whitespace-nowrap overflow-hidden text-ellipsis mr-2 text-left [direction:rtl]">
									{tool.path + "\u200E"}
								</span>
							</div>
						</div>
					)
				case "useSkill":
					return (
						<div>
							<div className={HEADER_CLASSNAMES}>
								<LightbulbIcon className="size-2" />
								<span className="font-bold">{t("tool.skillLoaded")}</span>
							</div>
							<div className="bg-code border border-editor-group-border overflow-hidden rounded-xs py-[9px] px-2.5">
								<span className="ph-no-capture font-medium">{tool.path}</span>
							</div>
						</div>
					)
				default:
					return <InvisibleSpacer />
			}
		}

		// Reset output expansion state when command stops (completes or is cancelled)
		useEffect(() => {
			// If command was executing and now isn't, clean up
			if (isCommandMessage && prevCommandExecutingRef.current && !isCommandExecuting) {
				setIsOutputFullyExpanded(false)
			}

			// Update ref for next render
			prevCommandExecutingRef.current = isCommandExecuting
		}, [isCommandMessage, isCommandExecuting])

		// Auto-expand when command starts executing (only if running > 500ms)
		useEffect(() => {
			if (isCommandMessage && isCommandExecuting && !isExpanded) {
				// Wait 500ms before auto-expanding to avoid animating fast commands
				const timer = setTimeout(() => {
					// Expand after 500ms
					onToggleExpand(message.ts)
				}, 500)

				return () => clearTimeout(timer)
			}
		}, [isCommandMessage, isCommandExecuting, isExpanded, onToggleExpand, message.ts])

		if (message.ask === "command" || message.say === "command") {
			return (
				<CommandOutputRow
					icon={icon}
					isBackgroundExec={vscodeTerminalExecutionMode === "backgroundExec"}
					isCommandCompleted={isCommandCompleted}
					isCommandExecuting={isCommandExecuting}
					isCommandPending={isCommandPending}
					isOutputFullyExpanded={isOutputFullyExpanded}
					message={message}
					onCancelCommand={onCancelCommand}
					setIsOutputFullyExpanded={setIsOutputFullyExpanded}
					title={title}
				/>
			)
		}

		if (message.ask === "use_subagents" || message.say === "use_subagents") {
			return <SubagentStatusRow isLast={isLast} lastModifiedMessage={lastModifiedMessage} message={message} />
		}

		if (message.ask === "use_mcp_server" || message.say === "use_mcp_server") {
			const useMcpServer = JSON.parse(message.text || "{}") as ClineAskUseMcpServer
			const server = mcpServers.find((server) => server.name === useMcpServer.serverName)
			return (
				<div>
					<div className={HEADER_CLASSNAMES}>
						{icon}
						{title}
					</div>

					<div className="bg-code rounded-xs py-2 px-2.5 mt-2">
						{useMcpServer.type === "access_mcp_resource" && (
							<McpResourceRow
								item={{
									...(findMatchingResourceOrTemplate(
										useMcpServer.uri || "",
										server?.resources,
										server?.resourceTemplates,
									) || {
										name: "",
										mimeType: "",
										description: "",
									}),
									uri: useMcpServer.uri || "",
								}}
							/>
						)}

						{useMcpServer.type === "use_mcp_tool" && (
							<div>
								<div onClick={(e) => e.stopPropagation()}>
									<McpToolRow
										serverName={useMcpServer.serverName}
										tool={{
											name: useMcpServer.toolName || "",
											description:
												server?.tools?.find((tool) => tool.name === useMcpServer.toolName)?.description ||
												"",
											autoApprove:
												server?.tools?.find((tool) => tool.name === useMcpServer.toolName)?.autoApprove ||
												false,
										}}
									/>
								</div>
								{useMcpServer.arguments && useMcpServer.arguments !== "{}" && (
									<div className="mt-2">
										<div className="mb-1 opacity-80 uppercase">{t("tool.arguments")}</div>
										<CodeAccordian
											code={useMcpServer.arguments}
											isExpanded={true}
											language="json"
											onToggleExpand={handleToggle}
										/>
									</div>
								)}
							</div>
						)}
					</div>
				</div>
			)
		}

		switch (message.type) {
			case "say":
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
			case "ask":
				switch (message.ask) {
					case "mistake_limit_reached":
						return <ErrorRow errorType="mistake_limit_reached" message={message} />
					case "completion_result":
						if (message.text) {
							const hasChanges = message.text.endsWith(COMPLETION_RESULT_CHANGES_FLAG) ?? false
							const text = hasChanges ? message.text.slice(0, -COMPLETION_RESULT_CHANGES_FLAG.length) : message.text
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
						}
						// Virtuoso cannot handle zero-height items; render a spacer instead of null
						return <InvisibleSpacer />
					case "followup":
						let question: string | undefined
						let options: string[] | undefined
						let selected: string | undefined
						try {
							const parsedMessage = JSON.parse(message.text || "{}") as ClineAskQuestion
							question = parsedMessage.question
							options = parsedMessage.options
							selected = parsedMessage.selected
						} catch (_e) {
							// legacy messages would pass question directly
							question = message.text
						}

						return (
							<div>
								{title && (
									<div className={HEADER_CLASSNAMES}>
										{icon}
										{title}
									</div>
								)}
								<WithCopyButton
									className="pt-1"
									onMouseUp={handleMouseUp}
									position="bottom-right"
									ref={contentRef}
									textToCopy={question}>
									<MarkdownRow markdown={question} />
									{quoteButtonState.visible && (
										<QuoteButton
											left={quoteButtonState.left}
											onClick={() => {
												handleQuoteClick()
											}}
											top={quoteButtonState.top}
										/>
									)}
								</WithCopyButton>
								<div className="pt-3">
									<OptionsButtons
										inputValue={inputValue}
										isActive={
											(isLast && lastModifiedMessage?.ask === "followup") ||
											(!selected && options && options.length > 0)
										}
										options={options}
										selected={selected}
									/>
								</div>
							</div>
						)
					case "new_task":
						return (
							<div>
								<div className={HEADER_CLASSNAMES}>
									<FilePlus2Icon className="size-2" />
									<span className="text-foreground font-bold">LIG VS가 새 작업을 시작하려고 합니다:</span>
								</div>
								<NewTaskPreview context={message.text || ""} />
							</div>
						)
					case "condense":
						return (
							<div>
								<div className={HEADER_CLASSNAMES}>
									<FilePlus2Icon className="size-2" />
									<span className="text-foreground font-bold">LIG VS가 대화를 압축하려고 합니다:</span>
								</div>
								<NewTaskPreview context={message.text || ""} />
							</div>
						)
					case "report_bug":
						return (
							<div>
								<div className={HEADER_CLASSNAMES}>
									<FilePlus2Icon className="size-2" />
									<span className="text-foreground font-bold">LIG VS가 GitHub 이슈를 만들려고 합니다:</span>
								</div>
								<ReportBugPreview data={message.text || ""} />
							</div>
						)
					case "plan_mode_respond": {
						let response: string | undefined
						let options: string[] | undefined
						let selected: string | undefined
						try {
							const parsedMessage = JSON.parse(message.text || "{}") as ClinePlanModeResponse
							response = parsedMessage.response
							options = parsedMessage.options
							selected = parsedMessage.selected
						} catch (_e) {
							// legacy messages would pass response directly
							response = message.text
						}
						return (
							<div>
								<PlanCompletionOutputRow
									headClassNames={HEADER_CLASSNAMES}
									text={response || message.text || ""}
								/>
								<OptionsButtons
									inputValue={inputValue}
									isActive={
										(isLast && lastModifiedMessage?.ask === "plan_mode_respond") ||
										(!selected && options && options.length > 0)
									}
									options={options}
									selected={selected}
								/>
							</div>
						)
					}
					default:
						return <InvisibleSpacer />
				}
		}
	},
)
