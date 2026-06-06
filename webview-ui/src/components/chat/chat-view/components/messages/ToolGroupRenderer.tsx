import { ClineMessage, ClineSayTool } from "@shared/ExtensionMessage"
import { StringRequest } from "@shared/proto/cline/common"
import { memo, useCallback, useMemo, useState } from "react"
import { cleanPathPrefix } from "@/components/common/CodeAccordian"
import { Button } from "@/components/ui/button"
import { useI18n, type UiLanguage } from "@/i18n"
import { cn } from "@/lib/utils"
import { FileServiceClient } from "@/services/grpc-client"
import { getIconByToolName, isLowStakesTool } from "../../utils/messageUtils"

interface ToolGroupRendererProps {
	messages: ClineMessage[]
	allMessages: ClineMessage[]
	isLastGroup: boolean
}

interface ToolWithReasoning {
	tool: ClineMessage
	parsedTool: ClineSayTool
	reasoning?: string
}

const EXPANDABLE_TOOLS = new Set(["listFilesTopLevel", "listFilesRecursive", "listCodeDefinitionNames", "searchFiles"])

/**
 * Renders a collapsible group of low-stakes tool calls.
 * Shows the tool messages exactly as the host normalized them.
 */
export const ToolGroupRenderer = memo(({ messages }: ToolGroupRendererProps) => {
	const [expandedItems, setExpandedItems] = useState<Record<number, boolean>>({})
	const { language } = useI18n()

	const allTools = useMemo(() => buildToolsWithReasoning(messages), [messages])

	const summary = getToolGroupSummaryFromParsedTools(allTools.map((item) => item.parsedTool), language)

	const handleOpenFile = useCallback((filePath: string) => {
		FileServiceClient.openFileRelativePath(StringRequest.create({ value: filePath })).catch((err) =>
			console.error("Failed to open file:", err),
		)
	}, [])

	const handleItemToggle = useCallback((ts: number) => {
		setExpandedItems((prev) => ({ ...prev, [ts]: !prev[ts] }))
	}, [])

	// Don't render if no tools to show
	if (allTools.length === 0) {
		return null
	}

	return (
		<div className="lig-tool-group rounded-sm border border-editor-group-border bg-code/70 px-2.5 py-2 text-description">
			{/* Header */}
			<div className="flex items-center gap-1.5 text-[13px] text-foreground font-semibold mb-1.5">
				<i className="codicon codicon-files text-description" />
				<span>{summary}</span>
			</div>

			{/* Content - unified list of completed + active tools */}
			<div className="min-w-0 flex flex-col gap-1">
				{allTools.map(({ tool, parsedTool }) => {
					const info = getToolDisplayInfo(parsedTool)
					if (!info) {
						return null
					}

					const isExpandable = EXPANDABLE_TOOLS.has(parsedTool.tool)
					const isItemExpanded = expandedItems[tool.ts] ?? false
					const content = parsedTool.content || null

					return (
						<div className="min-w-0" key={tool.ts}>
							<Button
								className="flex items-center gap-1.5 cursor-pointer text-[13px] text-description py-1 hover:text-link min-w-0 max-w-full px-1.5 leading-tight rounded-sm hover:bg-toolbar-hover-background"
								onClick={() => (isExpandable ? handleItemToggle(tool.ts) : handleOpenFile(info.path))}
								size="icon"
								variant="text">
								<info.icon className="opacity-80 shrink-0 size-[13px]" />
								<span
									className={cn(
										"flex-1 min-w-0 whitespace-nowrap overflow-hidden text-ellipsis text-left [direction:rtl] text-[13px]",
										{
											"[direction:ltr]": !!info.displayText,
										},
									)}>
									{(info.displayText || cleanPathPrefix(info.path)) + "\u200E"}
								</span>
							</Button>
							{/* Expanded content for folders/search/definitions - file lists only */}
							{isExpandable && isItemExpanded && content && (
								<pre className="m-1 ml-4 text-xs opacity-80 whitespace-pre-wrap break-words p-2 max-h-40 overflow-auto rounded-xs">
									{content}
								</pre>
							)}
						</div>
					)
				})}
			</div>
		</div>
	)
})

/**
 * Build tool items WITHOUT reasoning.
 * Reasoning should not be displayed in file lists - only file/folder content.
 */
export function buildToolsWithReasoning(messages: ClineMessage[]): ToolWithReasoning[] {
	const result: ToolWithReasoning[] = []

	for (const msg of messages) {
		// Skip reasoning messages - they should not be in file lists
		if (msg.say === "reasoning") {
			continue
		}

		if (isLowStakesTool(msg)) {
			const parsedTool = parseToolSafe(msg.text)
			const previous = result.at(-1)
			const supersedesPreviousReadAsk =
				parsedTool.tool === "readFile" &&
				parsedTool.path &&
				msg.say === "tool" &&
				previous?.tool.ask === "tool" &&
				previous.parsedTool.tool === "readFile" &&
				previous.parsedTool.path === parsedTool.path

			if (supersedesPreviousReadAsk) {
				result[result.length - 1] = {
					tool: msg,
					parsedTool,
					reasoning: undefined,
				}
				continue
			}
			result.push({
				tool: msg,
				parsedTool,
				reasoning: undefined, // Never show reasoning in file lists
			})
		}
	}

	return result
}

/**
 * Safely parse tool JSON, returning empty tool on failure.
 */
function parseToolSafe(text: string | undefined): ClineSayTool {
	try {
		return JSON.parse(text || "{}") as ClineSayTool
	} catch {
		return {} as ClineSayTool
	}
}

/**
 * Get display info for a tool.
 */
function getToolDisplayInfo(tool: ClineSayTool) {
	const icon = getIconByToolName(tool.tool)
	const filePath = tool.path || ""
	const folderPath = filePath + "/"

	switch (tool.tool) {
		case "readFile": {
			const lineNote =
				tool.readLineStart != null && tool.readLineEnd != null ? `lines ${tool.readLineStart}-${tool.readLineEnd}` : null
			return {
				icon,
				path: filePath,
				label: "read",
				displayText: lineNote ? `${cleanPathPrefix(filePath)} · ${lineNote}` : undefined,
			}
		}
		case "listFilesTopLevel":
			return { icon, path: folderPath, label: "listed" }
		case "listFilesRecursive":
			return { icon, path: folderPath, label: "listed recursively" }
		case "listCodeDefinitionNames":
			return { icon, path: folderPath, label: "definitions" }
		case "searchFiles":
			return {
				icon,
				path: folderPath,
				label: `search: ${tool.regex}`,
				displayText: formatSearchDisplay(tool.regex || "", filePath, tool.filePattern),
			}
		default:
			return null
	}
}

/**
 * Format search regex for display - simplify complex patterns
 */
function formatSearchDisplay(regex: string, path: string, filePattern?: string): string {
	// Split by | and clean up regex syntax
	const terms = regex
		.split("|")
		.map((t) => t.trim().replace(/\\b/g, "").replace(/\\s\?/g, " "))
		.filter(Boolean)

	const termDisplay = terms.length > 3 ? `패턴 ${terms.length}개` : `"${terms.join(" | ")}"`
	let result = `${cleanPathPrefix(path)}/에서 ${termDisplay}`

	if (filePattern && filePattern !== "*") {
		result += ` (${filePattern})`
	}

	return result
}

/**
 * Get summary label for a tool group - shows what's been added to context.
 */
export function getToolGroupSummaryFromParsedTools(tools: ClineSayTool[], language: UiLanguage = "ko"): string {
	const counts = { read: 0, list: 0, search: 0, def: 0 }

	for (const tool of tools) {
		switch (tool.tool) {
			case "readFile":
				counts.read++
				break
			case "listFilesTopLevel":
			case "listFilesRecursive":
				counts.list++
				break
			case "searchFiles":
				counts.search++
				break
			case "listCodeDefinitionNames":
				counts.def++
				break
		}
	}

	const readParts: string[] = []
	if (counts.read > 0) {
		readParts.push(language === "ko" ? `파일 ${counts.read}개` : `${counts.read} file${counts.read === 1 ? "" : "s"}`)
	}
	if (counts.list > 0) {
		readParts.push(language === "ko" ? `폴더 ${counts.list}개` : `${counts.list} folder${counts.list === 1 ? "" : "s"}`)
	}
	if (counts.def > 0) {
		readParts.push(language === "ko" ? `정의 ${counts.def}개` : `${counts.def} definition set${counts.def === 1 ? "" : "s"}`)
	}
	const parts: string[] = []
	if (readParts.length > 0) {
		parts.push(language === "ko" ? `${readParts.join(", ")} 확인` : `checked ${readParts.join(", ")}`)
	}
	if (counts.search > 0) {
		parts.push(language === "ko" ? `검색 ${counts.search}회 수행` : `ran ${counts.search} search${counts.search === 1 ? "" : "es"}`)
	}

	if (parts.length === 0) {
		return language === "ko" ? "컨텍스트" : "Context"
	}
	return language === "ko" ? `LIG VS가 ${parts.join(", ")}` : `LIG VS ${parts.join(", ")}`
}
