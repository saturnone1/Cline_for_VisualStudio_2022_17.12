/**
 * Utility functions for message filtering, grouping, and manipulation
 */

import { combineApiRequests } from "@shared/combineApiRequests"
import { combineCommandSequences } from "@shared/combineCommandSequences"
import type { ClineMessage, ClineSayBrowserAction, ClineSayTool } from "@shared/ExtensionMessage"
import { FileIcon, FolderOpenDotIcon, FolderOpenIcon, SearchIcon, ShapesIcon, WrenchIcon } from "lucide-react"

/**
 * Low-stakes tool types that should be grouped together
 */
const LOW_STAKES_TOOLS = new Set([
	"readFile",
	"listFilesTopLevel",
	"listFilesRecursive",
	"listCodeDefinitionNames",
	"searchFiles",
])

/**
 * Check if a tool message is a low-stakes tool
 */
export function isLowStakesTool(message: ClineMessage): boolean {
	if (message.say !== "tool" && message.ask !== "tool") {
		return false
	}
	try {
		const tool = JSON.parse(message.text || "{}") as ClineSayTool
		return LOW_STAKES_TOOLS.has(tool.tool)
	} catch {
		return false
	}
}

function isMeaninglessToolMessage(message: ClineMessage): boolean {
	if (message.say !== "tool" && message.ask !== "tool") {
		return false
	}
	try {
		const tool = JSON.parse(message.text || "{}") as Record<string, unknown>
		return !tool.tool && !tool.path && !tool.content && !tool.command && !tool.error
	} catch {
		return false
	}
}

function isEmptyJsonPlaceholder(value: string | undefined): boolean {
	const trimmed = (value || "").trim()
	return trimmed === "{}" || trimmed === "[]" || trimmed === "null" || trimmed === "undefined"
}

function stripRawToolCallMarkup(value: string | undefined): string {
	return (value || "")
		.replace(/<function\b[^>]*>[\s\S]*?<\/function>\s*<\/invoke>\s*<\/[^>\s]*:?tool_call>/gi, "")
		.replace(/<function\b[^>]*>[\s\S]*?<\/function>\s*<\/invoke>/gi, "")
		.replace(/<function=[\s\S]*?<\/function>\s*<\/tool_call>/gi, "")
		.replace(/<function\b[^>]*>[\s\S]*?<\/function>\s*<\/tool_call>/gi, "")
		.replace(/<tool_call\b[^>]*>[\s\S]*?<\/tool_call>/gi, "")
		.replace(/<\/?[^>\s]*:?tool_call>/gi, "")
		.trim()
}

function isCompletedProgressTitle(value: string | undefined): boolean {
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

function isMeaninglessTextMessage(message: ClineMessage): boolean {
	return message.type === "say" && message.say === "text" && isEmptyJsonPlaceholder(message.text)
}

function isMeaninglessReasoningMessage(message: ClineMessage): boolean {
	if (message.type !== "say" || message.say !== "reasoning") {
		return false
	}
	const reasoning = stripRawToolCallMarkup(message.reasoning)
	const text = stripRawToolCallMarkup(message.text)
	const visibleContent = reasoning || text
	if (isEmptyJsonPlaceholder(visibleContent)) {
		return true
	}
	if (!visibleContent) {
		return true
	}
	if (message.partial !== true && isCompletedProgressTitle(text) && (!reasoning || reasoning === text || isEmptyJsonPlaceholder(reasoning))) {
		return true
	}
	return false
}

function getApiRequestSummaryText(message: ClineMessage): string {
	try {
		return stripRawToolCallMarkup(String(JSON.parse(message.text || "{}").request || ""))
	} catch {
		return ""
	}
}

function getProgressMessageContent(message: ClineMessage): string {
	if (message.say === "api_req_started") {
		return getApiRequestSummaryText(message)
	}
	if (message.say === "reasoning") {
		return stripRawToolCallMarkup(String(message.reasoning || message.text || ""))
	}
	return ""
}

function getProgressMessageCategory(message: ClineMessage): string | undefined {
	if (message.say !== "reasoning" && message.say !== "api_req_started") {
		return undefined
	}

	const content = getProgressMessageContent(message)
	const label = String(message.text || "").trim()
	const normalized = `${label}\n${content}`.toLowerCase()

	if (
		normalized.includes("터미널 실행") ||
		normalized.includes("running terminal") ||
		normalized.includes("commands:") ||
		normalized.startsWith("lig vs ran")
	) {
		return "terminal"
	}
	if (
		normalized.includes("응답 준비") ||
		normalized.includes("preparing response") ||
		normalized.includes("model progress") ||
		normalized.includes("모델 진행")
	) {
		return "response"
	}
	if (
		normalized.includes("파일/도구") ||
		normalized.includes("파일 읽기") ||
		normalized.includes("reading files") ||
		normalized.includes("files:") ||
		normalized.startsWith("lig vs read") ||
		normalized.includes("tools:")
	) {
		return "files-tools"
	}
	if (normalized.includes("검색") || normalized.includes("searches:") || normalized.includes("performed")) {
		return "search"
	}
	if (normalized.includes("파일 편집") || normalized.includes("edits:") || normalized.includes("prepared")) {
		return "edits"
	}
	return content ? "progress" : undefined
}

function mergeProgressMessageContent(existing: string, next: string): string {
	const existingTrimmed = existing.trim()
	const nextTrimmed = next.trim()
	if (!existingTrimmed) {
		return nextTrimmed
	}
	if (!nextTrimmed || existingTrimmed.includes(nextTrimmed)) {
		return existingTrimmed
	}
	return `${existingTrimmed}\n\n${nextTrimmed}`
}

function setProgressMessageContent(message: ClineMessage, content: string): ClineMessage {
	if (message.say === "api_req_started") {
		try {
			const parsed = JSON.parse(message.text || "{}")
			return {
				...message,
				text: JSON.stringify({
					...parsed,
					request: content,
				}),
			}
		} catch {
			return message
		}
	}

	return {
		...message,
		reasoning: content,
	}
}

function compactCompletedProgressMessages(messages: ClineMessage[]): ClineMessage[] {
	const result: ClineMessage[] = []
	const categoryIndex = new Map<string, number>()

	for (const message of messages) {
		const category = message.partial === true ? undefined : getProgressMessageCategory(message)
		const content = getProgressMessageContent(message)
		const isCompletedProgressMessage =
			message.partial !== true && (message.say === "reasoning" || message.say === "api_req_started")

		if (!content && isCompletedProgressMessage) {
			continue
		}

		if (!category || !content) {
			result.push(message)
			continue
		}

		const existingIndex = categoryIndex.get(category)
		if (existingIndex === undefined) {
			categoryIndex.set(category, result.length)
			result.push(setProgressMessageContent(message, content))
			continue
		}

		const existing = result[existingIndex]
		const mergedContent = mergeProgressMessageContent(getProgressMessageContent(existing), content)
		result[existingIndex] = setProgressMessageContent(existing, mergedContent)
	}

	return result
}

function isVisibleProgressRequest(message: ClineMessage): boolean {
	const request = getApiRequestSummaryText(message)
	if (!request) {
		return false
	}

	const normalized = request.replace(/\s+/g, " ").trim()
	if (
		normalized === "모델 진행 중" ||
		normalized === "모델 진행 기록" ||
		normalized === "Cline SDK is thinking..." ||
		/^Cline SDK iteration \d+ (started|finished)\./i.test(normalized)
	) {
		return false
	}

	return /\b(Files|Searches|Edits|Commands|Tools):/i.test(request) || /^LIG VS (read|performed|prepared|ran|used)\b/i.test(normalized)
}

/**
 * Check if a message group is a tool group (array with _isToolGroup marker)
 */
export function isToolGroup(item: ClineMessage | ClineMessage[]): item is ClineMessage[] & { _isToolGroup: true } {
	return Array.isArray(item) && (item as any)._isToolGroup === true
}

/**
 * Combine API requests and command sequences in messages
 */
export function processMessages(messages: ClineMessage[]): ClineMessage[] {
	return combineApiRequests(combineCommandSequences(messages))
}

/**
 * Filter messages that should be visible in the chat
 */
export function filterVisibleMessages(messages: ClineMessage[]): ClineMessage[] {
	return messages.filter((message, index, arr) => {
		if (isMeaninglessTextMessage(message)) {
			return false
		}
		if (isMeaninglessReasoningMessage(message)) {
			return false
		}
		if (isMeaninglessToolMessage(message)) {
			return false
		}
		switch (message.ask) {
			case "completion_result":
				// don't show a chat row for a completion_result ask without text. This specific type of message only occurs if cline wants to execute a command as part of its completion result, in which case we interject the completion_result tool with the execute_command tool.
				if (message.text === "") {
					return false
				}
				break
			case "api_req_failed": // this message is used to update the latest api_req_started that the request failed
			case "resume_task":
			case "resume_completed_task":
				return false
			case "use_subagents":
				if (arr.slice(index + 1).some((candidate) => candidate.type === "say" && candidate.say === "subagent")) {
					return false
				}
				break
		}
		switch (message.say) {
			case "api_req_finished": // combineApiRequests removes this from modifiedMessages anyways
			case "api_req_retried": // this message is used to update the latest api_req_started that the request was retried
			case "deleted_api_reqs": // aggregated api_req metrics from deleted messages
			case "subagent_usage": // aggregated subagent usage metrics for task-level accounting
			case "task_progress": // task progress messages are displayed in TaskHeader, not in main chat
				return false
			// NOTE: reasoning passes through to be included in tool groups
			case "api_req_started": {
				// SDK progress summaries are normalized into api_req_started so the
				// live and restored transcripts use the same folded progress row.
				if (isVisibleProgressRequest(message)) {
					break
				}
				// Other api_req_started rows only render visible content for errors/cancels.
				// Reasoning has its own standalone ChatRows. Everything else is internal
				// bookkeeping and should stay hidden.
				try {
					const info = JSON.parse(message.text || "{}")
					if (info.cancelReason || info.streamingFailedMessage) {
						break // keep - has error content
					}
				} catch {
					break // keep on parse error to be safe
				}
				return false
			}
			case "text":
				// Sometimes cline returns an empty text message, we don't want to render these. (We also use a say text for user messages, so in case they just sent images we still render that)
				if ((message.text ?? "") === "" && (message.images?.length ?? 0) === 0) {
					return false
				}
				break
			case "mcp_server_request_started":
				return false
			case "use_subagents":
				if (arr.slice(index + 1).some((candidate) => candidate.type === "say" && candidate.say === "subagent")) {
					return false
				}
				break
		}
		return true
	})
}

/**
 * Check if a message is part of a browser session
 */
export function isBrowserSessionMessage(message: ClineMessage): boolean {
	if (message.type === "ask") {
		return ["browser_action_launch"].includes(message.ask!)
	}
	if (message.type === "say") {
		return [
			"browser_action_launch",
			"api_req_started",
			"text",
			"browser_action",
			"browser_action_result",
			"checkpoint_created",
			"reasoning",
			"error_retry",
		].includes(message.say!)
	}
	return false
}

/**
 * Group messages, combining browser session messages into arrays
 */
export function groupMessages(visibleMessages: ClineMessage[]): (ClineMessage | ClineMessage[])[] {
	const result: (ClineMessage | ClineMessage[])[] = []
	let currentGroup: ClineMessage[] = []
	let isInBrowserSession = false

	const endBrowserSession = () => {
		if (currentGroup.length > 0) {
			result.push([...currentGroup])
			currentGroup = []
			isInBrowserSession = false
		}
	}

	for (const message of visibleMessages) {
		if (message.ask === "browser_action_launch" || message.say === "browser_action_launch") {
			// complete existing browser session if any
			endBrowserSession()
			// start new
			isInBrowserSession = true
			currentGroup.push(message)
		} else if (isInBrowserSession) {
			// end session if api_req_started is cancelled
			if (message.say === "api_req_started") {
				// get last api_req_started in currentGroup to check if it's cancelled
				const lastApiReqStarted = [...currentGroup].reverse().find((m) => m.say === "api_req_started")
				if (lastApiReqStarted?.text != null) {
					const info = JSON.parse(lastApiReqStarted.text)
					const isCancelled = info.cancelReason != null
					if (isCancelled) {
						endBrowserSession()
						result.push(message)
						continue
					}
				}
			}

			if (isBrowserSessionMessage(message)) {
				currentGroup.push(message)

				// Check if this is a close action
				if (message.say === "browser_action") {
					const browserAction = JSON.parse(message.text || "{}") as ClineSayBrowserAction
					if (browserAction.action === "close") {
						endBrowserSession()
					}
				}
			} else {
				// complete existing browser session if any
				endBrowserSession()
				result.push(message)
			}
		} else {
			result.push(message)
		}
	}

	// Handle case where browser session is the last group
	if (currentGroup.length > 0) {
		result.push([...currentGroup])
	}

	return result
}

/**
 * Get the task message from the messages array
 */
export function getTaskMessage(messages: ClineMessage[]): ClineMessage | undefined {
	return messages.at(0)
}

/**
 * Check if we should show the scroll to bottom button
 */
export function shouldShowScrollButton(disableAutoScroll: boolean, isAtBottom: boolean): boolean {
	return disableAutoScroll && !isAtBottom
}

/**
 * Group consecutive low-stakes tools (and their reasoning) into arrays.
 * Also filters out checkpoints that follow low-stakes tool groups.
 * Only creates tool groups when there's at least one actual tool.
 * Should be called after groupMessages.
 */
export function groupLowStakesTools(groupedMessages: (ClineMessage | ClineMessage[])[]): (ClineMessage | ClineMessage[])[] {
	const result: (ClineMessage | ClineMessage[])[] = []
	let toolGroup: ClineMessage[] = []
	let hasTools = false

	const commitToolGroup = () => {
		if (toolGroup.length > 0 && hasTools) {
			const group = toolGroup as ClineMessage[] & { _isToolGroup: boolean }
			group._isToolGroup = true
			result.push(group)
		} else {
			result.push(...compactCompletedProgressMessages(toolGroup))
		}
		toolGroup = []
		hasTools = false
	}

	for (let i = 0; i < groupedMessages.length; i++) {
		const item = groupedMessages[i]

		// Browser session group - commit current work and pass through
		if (Array.isArray(item)) {
			commitToolGroup()
			result.push(item)
			continue
		}

		const message = item
		const messageType = message.say

		// Low-stakes tool - add to the current folded tool group.
		if (isLowStakesTool(message)) {
			hasTools = true
			toolGroup.push(message)
			continue
		}

		// Reasoning and api_req rows stay in order. If tools follow, they become
		// part of the same folded progress group; otherwise they render as rows.
		if (messageType === "reasoning") {
			const content = getProgressMessageContent(message)
			if (content) {
				toolGroup.push(setProgressMessageContent(message, content))
			}
			continue
		}

		if (messageType === "api_req_started") {
			const content = getProgressMessageContent(message)
			if (content) {
				toolGroup.push(setProgressMessageContent(message, content))
			}
			continue
		}

		// Checkpoint - absorb into active tool group
		if (messageType === "checkpoint_created" && hasTools) {
			toolGroup.push(message)
			continue
		}

		// Text after a tool group is the assistant's visible answer. Commit the
		// folded tool/progress block first, then render the answer normally.
		if (messageType === "text") {
			commitToolGroup()
			result.push(message)
			continue
		}

		// Everything else - commit group, flush pending, and render
		commitToolGroup()
		result.push(message)
	}

	// Finalize any remaining work
	commitToolGroup()

	return result
}

export function getIconByToolName(toolName: string) {
	switch (toolName) {
		case "readFile":
			return FileIcon
		case "listFilesTopLevel":
			return FolderOpenIcon
		case "listFilesRecursive":
			return FolderOpenDotIcon
		case "searchFiles":
			return SearchIcon
		case "listCodeDefinitionNames":
			return ShapesIcon
		default:
			return WrenchIcon
	}
}
