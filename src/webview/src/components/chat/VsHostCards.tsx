import { ClineMessage, ClineSayTool } from "@shared/ExtensionMessage"
import {
	ArrowRightIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	FileCode2Icon,
	PencilIcon,
	SquareArrowOutUpRightIcon,
	TerminalIcon,
	Undo2Icon,
} from "lucide-react"
import { MouseEvent, memo, useCallback, useMemo, useState } from "react"
import { useI18n } from "@/i18n"
import { cn } from "@/lib/utils"
import { FileServiceClient, UiServiceClient } from "@/services/grpcClient"
import { cleanPathPrefix } from "../common/CodeAccordian"

type VsClineChangedFile = {
	filePath: string
	beforePath: string
	afterPath: string
	action: string
	additions: number
	deletions: number
}

export type VsCommandOutputSummary = {
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

export const VsCommandOutputCard = memo(
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

export function parseVsCommandOutputSummary(text: string): VsCommandOutputSummary[] {
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

export const VsClineChangedFilesCard = memo(({ tool }: { tool: ClineSayTool }) => {
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

export const VsClineRevertedFilesCard = memo(({ tool }: { tool: ClineSayTool }) => {
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
