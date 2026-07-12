import { ClineMessage, ClineSayTool } from "@shared/ExtensionMessage"
import { StringRequest } from "@shared/proto/cline/common"
import {
	ChevronDownIcon,
	ChevronRightIcon,
	FileCode2Icon,
	FilePlus2Icon,
	FoldVerticalIcon,
	ImageUpIcon,
	LightbulbIcon,
	Link2Icon,
	PencilIcon,
	SearchIcon,
	SquareArrowOutUpRightIcon,
	SquareMinusIcon,
} from "lucide-react"
import { memo } from "react"
import { useI18n } from "@/i18n"
import { cn } from "@/lib/utils"
import { FileServiceClient, UiServiceClient } from "@/services/grpcClient"
import CodeAccordian, { cleanPathPrefix } from "../common/CodeAccordian"
import { DiffEditRow } from "./DiffEditRow"
import SearchResultsDisplay from "./SearchResultsDisplay"
import { VsClineChangedFilesCard, VsClineRevertedFilesCard } from "./VsHostCards"

const HEADER_CLASSNAMES = "flex items-center gap-2.5 mb-3"
const InvisibleSpacer = () => <div aria-hidden className="h-px" />

export function isImageFile(filePath: string): boolean {
	const extension = filePath.toLowerCase().split(".").pop()
	return extension ? ["png", "jpg", "jpeg", "webp"].includes(extension) : false
}

interface ToolMessageRendererProps {
	tool: ClineSayTool
	message: ClineMessage
	isExpanded: boolean
	onToggle: () => void
	backgroundEditEnabled: boolean
}

export const ToolMessageRenderer = memo(
	({ tool, message, isExpanded, onToggle: handleToggle, backgroundEditEnabled }: ToolMessageRendererProps) => {
		const { t, language } = useI18n()
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
	},
)
