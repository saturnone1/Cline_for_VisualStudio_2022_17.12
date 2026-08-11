import {
	getCommandText,
	getPatchPathsFromUnknown,
	getSearchFilePattern,
	getSearchQuery,
	getToolPath,
	getToolPathFromUnknown,
	summarizeToolInput,
} from "./ToolCommandFormatting"

type ApprovalPrompt = Readonly<{ ask: "command" | "tool"; text: string }>

export class ToolApprovalPromptProjector {
	blockedReason(language: "en" | "ko") {
		return language === "ko"
			? "Plan 모드에서는 실행, 수정, 브라우저 또는 MCP 도구를 사용할 수 없습니다. Act 모드로 전환한 후 다시 시도해 주세요."
			: "Plan mode does not run execution, edit, browser, or MCP tools. Switch to Act mode and try again."
	}

	build(mappedToolName: string, input: Record<string, unknown>, approvalRequest: Record<string, unknown>): ApprovalPrompt {
		if (mappedToolName === "executeCommand") {
			return {
				ask: "command",
				text: JSON.stringify({
					command: getCommandText(input),
					description: stringValue(approvalRequest.description) || stringValue(approvalRequest.reason) || "LIG VS가 이 명령을 실행하려고 합니다.",
				}),
			}
		}
		return {
			ask: "tool",
			text: JSON.stringify({
				tool: mappedToolName,
				path: mappedToolName === "searchFiles" ? getToolPath(input) || "/" : getPatchPathsFromUnknown(input) || getToolPathFromUnknown(input),
				regex: mappedToolName === "searchFiles" ? getSearchQuery(input) : undefined,
				filePattern: mappedToolName === "searchFiles" ? getSearchFilePattern(input) : undefined,
				content: stringValue(approvalRequest.description) || stringValue(approvalRequest.reason) || summarizeToolInput(input),
				...input,
			}),
		}
	}
}

function stringValue(value: unknown) { return typeof value === "string" ? value : "" }
