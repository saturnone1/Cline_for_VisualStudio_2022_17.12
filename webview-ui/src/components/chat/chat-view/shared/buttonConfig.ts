import type { ClineMessage, ClineSayTool } from "@shared/ExtensionMessage"
import type { Mode } from "@shared/storage/types"
import { translate, type UiLanguage } from "@/i18n"

/**
 * Button action types that determine the behavior
 */
export type ButtonActionType =
	| "approve" // Send yesButtonClicked
	| "reject" // Send noButtonClicked
	| "proceed" // Send messageResponse or yesButtonClicked
	| "new_task" // Start a new task
	| "cancel" // Cancel streaming
	| "utility" // Execute utility function (condense, report_bug)
	| "retry" // Retry the last action

/**
 * Button configuration for different message states
 */
export interface ButtonConfig {
	sendingDisabled: boolean
	enableButtons: boolean
	primaryText?: string
	secondaryText?: string
	primaryAction?: ButtonActionType
	secondaryAction?: ButtonActionType
}

/**
 * Centralized button state configurations based on task lifecycle
 * This is the single source of truth for both button display and actions
 */
export const BUTTON_CONFIGS: Record<string, ButtonConfig> = {
	// Error recovery states - user must take action
	api_req_failed: {
		sendingDisabled: true,
		enableButtons: true,
		primaryText: "다시 시도",
		secondaryText: undefined,
		primaryAction: "retry",
		secondaryAction: undefined,
	},
	mistake_limit_reached: {
		sendingDisabled: false,
		enableButtons: true,
		primaryText: "그래도 계속",
		secondaryText: undefined,
		primaryAction: "proceed",
		secondaryAction: undefined,
	},

	// Tool approval states - most common during task execution
	tool_approve: {
		sendingDisabled: false,
		enableButtons: true,
		primaryText: "승인",
		secondaryText: "거부",
		primaryAction: "approve",
		secondaryAction: "reject",
	},
	tool_save: {
		sendingDisabled: false,
		enableButtons: true,
		primaryText: "저장",
		secondaryText: "거부",
		primaryAction: "approve",
		secondaryAction: "reject",
	},

	// Command execution states
	command: {
		sendingDisabled: false,
		enableButtons: true,
		primaryText: "명령 실행",
		secondaryText: "거부",
		primaryAction: "approve",
		secondaryAction: "reject",
	},
	command_output: {
		sendingDisabled: false,
		enableButtons: true,
		primaryText: "실행 중 계속",
		secondaryText: undefined,
		primaryAction: "proceed",
		secondaryAction: undefined,
	},

	// Browser and external tool states
	browser_action_launch: {
		sendingDisabled: false,
		enableButtons: true,
		primaryText: "승인",
		secondaryText: "거부",
		primaryAction: "approve",
		secondaryAction: "reject",
	},
	use_mcp_server: {
		sendingDisabled: false,
		enableButtons: true,
		primaryText: "승인",
		secondaryText: "거부",
		primaryAction: "approve",
		secondaryAction: "reject",
	},
	use_subagents: {
		sendingDisabled: false,
		enableButtons: true,
		primaryText: "승인",
		secondaryText: "거부",
		primaryAction: "approve",
		secondaryAction: "reject",
	},
	followup: {
		sendingDisabled: false,
		enableButtons: false,
		primaryText: undefined,
		secondaryText: undefined,
		primaryAction: undefined,
		secondaryAction: undefined,
	},
	plan_mode_respond: {
		sendingDisabled: false,
		enableButtons: false,
		primaryText: undefined,
		secondaryText: undefined,
		primaryAction: undefined,
		secondaryAction: undefined,
	},

	// Task lifecycle states
	completion_result: {
		sendingDisabled: false,
		enableButtons: false,
		primaryText: undefined,
		secondaryText: undefined,
		primaryAction: undefined,
		secondaryAction: undefined,
	},
	resume_task: {
		sendingDisabled: false,
		enableButtons: true,
		primaryText: "작업 이어서 하기",
		secondaryText: undefined,
		primaryAction: "proceed",
		secondaryAction: undefined,
	},
	resume_completed_task: {
		sendingDisabled: false,
		enableButtons: false,
		primaryText: undefined,
		secondaryText: undefined,
		primaryAction: undefined,
		secondaryAction: undefined,
	},
	new_task: {
		sendingDisabled: false,
		enableButtons: false,
		primaryText: undefined,
		secondaryText: undefined,
		primaryAction: undefined,
		secondaryAction: undefined,
	},

	// Utility states
	condense: {
		sendingDisabled: false,
		enableButtons: true,
		primaryText: "대화 압축",
		secondaryText: undefined,
		primaryAction: "utility",
		secondaryAction: undefined,
	},
	report_bug: {
		sendingDisabled: false,
		enableButtons: true,
		primaryText: "GitHub 이슈 작성",
		secondaryText: undefined,
		primaryAction: "utility",
		secondaryAction: undefined,
	},

	// Streaming/partial states - disable interaction during streaming
	partial: {
		sendingDisabled: true,
		enableButtons: true,
		primaryText: undefined,
		secondaryText: "취소",
		primaryAction: undefined,
		secondaryAction: "cancel",
	},

	// Default states
	default: {
		sendingDisabled: false,
		enableButtons: false,
		primaryText: undefined,
		secondaryText: undefined,
		primaryAction: undefined,
		secondaryAction: undefined,
	},
	api_req_active: {
		sendingDisabled: true,
		enableButtons: true,
		primaryText: undefined,
		secondaryText: "취소",
		primaryAction: undefined,
		secondaryAction: "cancel",
	},
}

const errorTypes = ["api_req_failed", "mistake_limit_reached"]

function parseApiRequestInfo(message: ClineMessage): Record<string, unknown> {
	try {
		return JSON.parse(message.text || "{}") as Record<string, unknown>
	} catch {
		return {}
	}
}

function localizeButtonConfig(config: ButtonConfig, language: UiLanguage): ButtonConfig {
	const localized = { ...config }
	switch (localized.primaryText) {
		case "Approve":
		case "승인":
			localized.primaryText = translate(language, "common.approve")
			break
		case "Reject":
		case "거부":
			localized.primaryText = translate(language, "common.reject")
			break
		case "Save":
		case "저장":
			localized.primaryText = translate(language, "common.save")
			break
		case "Run Command":
		case "명령 실행":
			localized.primaryText = translate(language, "command.run")
			break
		case "Proceed While Running":
		case "실행 중 계속":
			localized.primaryText = translate(language, "command.proceedWhileRunning")
			break
		case "Start New Task":
		case "새 작업 시작":
			localized.primaryText = language === "ko" ? "새 작업 시작" : "Start New Task"
			break
		case "Start New Task with Context":
		case "컨텍스트로 새 작업 시작":
			localized.primaryText = language === "ko" ? "컨텍스트로 새 작업 시작" : "Start New Task with Context"
			break
		case "Resume Task":
		case "작업 이어서 하기":
			localized.primaryText = language === "ko" ? "작업 이어서 하기" : "Resume Task"
			break
		case "Condense Conversation":
		case "대화 압축":
			localized.primaryText = language === "ko" ? "대화 압축" : "Condense Conversation"
			break
		case "Report GitHub issue":
		case "GitHub 이슈 작성":
			localized.primaryText = language === "ko" ? "GitHub 이슈 작성" : "Report GitHub issue"
			break
		case "Retry":
		case "다시 시도":
			localized.primaryText = language === "ko" ? "다시 시도" : "Retry"
			break
		case "Proceed Anyways":
		case "그래도 계속":
			localized.primaryText = language === "ko" ? "그래도 계속" : "Proceed Anyways"
			break
	}
	switch (localized.secondaryText) {
		case "Approve":
		case "승인":
			localized.secondaryText = translate(language, "common.approve")
			break
		case "Reject":
		case "거부":
			localized.secondaryText = translate(language, "common.reject")
			break
		case "Cancel":
		case "취소":
			localized.secondaryText = translate(language, "common.cancel")
			break
		case "Start New Task":
		case "새 작업 시작":
			localized.secondaryText = language === "ko" ? "새 작업 시작" : "Start New Task"
			break
	}
	return localized
}

function isApiRequestStillActive(message: ClineMessage) {
	if (message.partial !== true) {
		return false
	}

	const info = parseApiRequestInfo(message)
	if (info.cancelReason || info.streamingFailedMessage) {
		return false
	}

	const hasUsage =
		typeof info.cost === "number" ||
		typeof info.totalCost === "number" ||
		typeof info.tokensIn === "number" ||
		typeof info.tokensOut === "number" ||
		typeof info.cacheWrites === "number" ||
		typeof info.cacheReads === "number"

	return !hasUsage
}

/**
 * Determines button configuration based on message type and state
 * This is the single source of truth used by both ActionButtons and useMessageHandlers
 */
export function getButtonConfig(message: ClineMessage | undefined, _mode: Mode = "act", language: UiLanguage = "ko"): ButtonConfig {
	const resolve = (config: ButtonConfig) => localizeButtonConfig(config, language)
	if (!message) {
		return resolve(BUTTON_CONFIGS.default)
	}

	const isStreaming = message.partial === true
	const isError = message?.ask ? errorTypes.includes(message.ask) : false

	// Terminal task states must win over stale/accidental partial flags. The
	// SDK bridge may receive completion before a final state refresh, and Cline's
	// normal lifecycle treats completion as user-interactable, not cancellable.
	if (message.type === "say" && message.say === "completion_result") {
		return resolve(BUTTON_CONFIGS.completion_result)
	}

	// Special case: command_output should show "Proceed While Running" button even while streaming
	// This allows terminal output to stream while still showing the action button
	if (message.type === "ask" && message.ask === "command_output") {
		return resolve(BUTTON_CONFIGS.command_output)
	}

	// Handle partial/streaming messages first (most common during task execution)
	// This must be checked before any other conditions to ensure streaming state takes precedence
	if (isStreaming && !isError) {
		return resolve(BUTTON_CONFIGS.partial)
	}

	// Handle ask messages (user interaction required)
	if (message.type === "ask") {
		switch (message.ask) {
			// Error recovery states
			case "api_req_failed":
				return resolve(BUTTON_CONFIGS.api_req_failed)
			case "mistake_limit_reached":
				return resolve(BUTTON_CONFIGS.mistake_limit_reached)

			// Tool approval (most common)
			case "tool": {
				// Only parse JSON if we need to determine save vs approve
				try {
					const tool = JSON.parse(message.text || "{}") as ClineSayTool
					if (tool.tool === "editedExistingFile" || tool.tool === "newFileCreated" || tool.tool === "fileDeleted") {
						return resolve(BUTTON_CONFIGS.tool_save)
					}
				} catch {
					// Fall through to default tool approval
				}
				return resolve(BUTTON_CONFIGS.tool_approve)
			}

			// Command execution
			case "command":
				return resolve(BUTTON_CONFIGS.command)
			case "command_output":
				return resolve(BUTTON_CONFIGS.command_output)

			// Standard approvals
			case "followup":
				return resolve(BUTTON_CONFIGS.followup)
			case "browser_action_launch":
				return resolve(BUTTON_CONFIGS.browser_action_launch)
			case "use_mcp_server":
				return resolve(BUTTON_CONFIGS.use_mcp_server)
			case "use_subagents":
				return resolve(BUTTON_CONFIGS.use_subagents)
			case "plan_mode_respond":
				return resolve(BUTTON_CONFIGS.plan_mode_respond)

			// Task lifecycle
			case "completion_result":
				return resolve(BUTTON_CONFIGS.completion_result)
			case "resume_task":
				return resolve(BUTTON_CONFIGS.resume_task)
			case "resume_completed_task":
				return resolve(BUTTON_CONFIGS.resume_completed_task)
			case "new_task":
				return resolve(BUTTON_CONFIGS.new_task)

			// Utility
			case "condense":
				return resolve(BUTTON_CONFIGS.condense)
			case "report_bug":
				return resolve(BUTTON_CONFIGS.report_bug)

			default:
				return resolve(BUTTON_CONFIGS.tool_approve)
		}
	}

	if (message.type === "say" && message.say === "api_req_started") {
		return resolve(isApiRequestStillActive(message) ? BUTTON_CONFIGS.api_req_active : BUTTON_CONFIGS.default)
	}

	// Special case: command_output say messages should show "Proceed While Running" button
	// This allows terminal output to stream while still showing the action button
	if (message.type === "say" && message.say === "command_output") {
		return resolve(BUTTON_CONFIGS.command_output)
	}

	return resolve(BUTTON_CONFIGS.default)
}
