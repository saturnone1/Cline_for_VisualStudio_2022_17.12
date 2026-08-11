import { VSCodeButton } from "@vscode/webview-ui-toolkit/react";
import {
	AlertCircle,
	Check,
	ExternalLink,
	FolderOpen,
	GitBranch,
	GitMerge,
	Loader2,
	Plus,
	Trash2,
} from "lucide-react";
import { memo } from "react";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { getEnvironmentColor } from "@/utils/environmentColors";
import { WorktreeOperationDialogs } from "./WorktreeOperationDialogs";

type WorktreesViewProps = {
	onDone: () => void;
};

import { useWorktreesViewController } from "./useWorktreesViewController";

const WorktreesView: React.FC<WorktreesViewProps> = ({ onDone }) => {
	const controller = useWorktreesViewController({ onDone });
	const {
		environment,
		t,
		worktrees,
		isLoading,
		error,
		isGitRepo,
		isMultiRoot,
		isSubfolder,
		gitRootPath,
		errorKind,
		showCreateForm,
		setShowCreateForm,
		deleteWorktree,
		setDeleteWorktree,
		operationMessage,
		setOperationMessage,
		setIsOperating,
		pendingSwitch,
		setPendingSwitch,
		selectedSolutionPath,
		setSelectedSolutionPath,
		mergeWorktree,
		isMerging,
		mergeError,
		mergeResult,
		deleteAfterMerge,
		setDeleteAfterMerge,
		hasWorktreeInclude,
		hasGitignore,
		isCreatingWorktreeInclude,
		isMainWorktree,
		loadWorktrees,
		handleCreateWorktreeInclude,
		handleDeleteWorktree,
		handleSwitchWorktree,
		getMainBranch,
		openMergeModal,
		closeMergeModal,
		handleMergeWorktree,
		handleAskClineToResolve,
	} = controller;

	return (
		<div className="absolute inset-0 flex flex-col overflow-hidden">
			{/* Sticky Header with title and Done button */}
			<div className="flex-none flex justify-between items-center px-5 py-3 border-b border-[var(--vscode-panel-border)]">
				<h3 className="m-0" style={{ color: getEnvironmentColor(environment) }}>
					{t("worktrees.title")}
				</h3>
				<VSCodeButton onClick={onDone}>{t("common.done")}</VSCodeButton>
			</div>

			{/* Scrollable Content */}
			<div className="flex-1 overflow-y-auto p-5">
				{/* Description */}
				<p className="text-sm text-[var(--vscode-descriptionForeground)] m-0 mb-4">
					{t("worktrees.description")}{" "}
					<a
						className="text-[var(--vscode-textLink-foreground)] hover:text-[var(--vscode-textLink-activeForeground)]"
						href="https://docs.cline.bot/features/worktrees"
						rel="noopener noreferrer"
						style={{ fontSize: "inherit" }}
						target="_blank"
					>
						{t("worktrees.learnMore")}
					</a>
				</p>

				{/* .worktreeinclude status */}
				{isGitRepo && !isMultiRoot && !isSubfolder && (
					<div
						className="p-3 rounded-md"
						style={{
							border: "1px solid var(--vscode-widget-border)",
							backgroundColor: "var(--vscode-list-hoverBackground)",
						}}
					>
						{hasWorktreeInclude ? (
							<p className="text-sm text-[var(--vscode-testing-iconPassed)] m-0">
								<Check className="w-4 h-4 inline-block align-text-bottom mr-1" />
								{t("worktrees.includeDetected")}{" "}
								<a
									className="text-[var(--vscode-textLink-foreground)] hover:text-[var(--vscode-textLink-activeForeground)]"
									href="https://docs.cline.bot/features/worktrees#worktreeinclude"
									rel="noopener noreferrer"
									style={{ fontSize: "inherit" }}
									target="_blank"
								>
									{t("worktrees.learnMore")}
								</a>
							</p>
						) : (
							<div className="flex flex-col gap-2">
								<p className="text-sm text-[var(--vscode-descriptionForeground)] m-0">
									<strong>{t("worktrees.tip")}</strong>{" "}
									{t("worktrees.includeTip")}{" "}
									<a
										className="text-[var(--vscode-textLink-foreground)] hover:text-[var(--vscode-textLink-activeForeground)]"
										href="https://docs.cline.bot/features/worktrees#worktreeinclude"
										rel="noopener noreferrer"
										style={{ fontSize: "inherit" }}
										target="_blank"
									>
										{t("worktrees.learnMore")}
									</a>
								</p>
								{hasGitignore && (
									<VSCodeButton
										appearance="secondary"
										disabled={isCreatingWorktreeInclude}
										onClick={handleCreateWorktreeInclude}
									>
										{isCreatingWorktreeInclude ? (
											<>
												<Loader2 className="w-3 h-3 mr-1 animate-spin" />
												{t("worktrees.creating")}
											</>
										) : (
											t("worktrees.createFromGitignore")
										)}
									</VSCodeButton>
								)}
							</div>
						)}
					</div>
				)}

				{/* Loading/Error States */}
				{operationMessage && !error && (
					<div className="mt-3 flex items-start gap-2 rounded border border-[var(--vscode-testing-iconPassed)] p-3 text-sm">
						<Check className="w-4 h-4 text-[var(--vscode-testing-iconPassed)] mt-0.5" />
						<span>{operationMessage}</span>
					</div>
				)}
				{isLoading ? (
					<div className="flex items-center justify-center min-h-32 py-8">
						<Loader2 className="w-6 h-6 animate-spin text-[var(--vscode-descriptionForeground)]" />
						<span className="ml-2 text-[var(--vscode-descriptionForeground)]">
							{t("worktrees.loading")}
						</span>
					</div>
				) : isMultiRoot ? (
					<div className="flex flex-col items-center justify-center min-h-32 py-8 text-center">
						<AlertCircle className="w-8 h-8 text-[var(--vscode-inputValidation-warningForeground)] mb-2 shrink-0" />
						<p className="text-[var(--vscode-foreground)] font-medium mb-1">
							{t("worktrees.multiRootTitle")}
						</p>
						<p className="text-[var(--vscode-descriptionForeground)] text-sm">
							{t("worktrees.multiRootDescription")}
						</p>
					</div>
				) : isSubfolder ? (
					<div className="flex flex-col items-center justify-center min-h-32 py-8 text-center">
						<AlertCircle className="w-8 h-8 text-[var(--vscode-inputValidation-warningForeground)] mb-2 shrink-0" />
						<p className="text-[var(--vscode-foreground)] font-medium mb-1">
							{t("worktrees.subfolderTitle")}
						</p>
						<p className="text-[var(--vscode-descriptionForeground)] text-sm">
							{t("worktrees.subfolderDescription")}
						</p>
						<code className="mt-2 px-2 py-1 bg-[var(--vscode-textCodeBlock-background)] rounded text-sm break-all">
							{gitRootPath}
						</code>
					</div>
				) : !isGitRepo ? (
					<div className="flex flex-col items-center justify-center min-h-32 py-8 text-center">
						<AlertCircle className="w-8 h-8 text-[var(--vscode-descriptionForeground)] mb-2 shrink-0" />
						<p className="text-[var(--vscode-foreground)] font-medium mb-1">
							{errorKind === "git_missing"
								? t("worktrees.gitMissing")
								: errorKind === "workspace_missing"
									? t("worktrees.workspaceMissing")
									: t("worktrees.gitRequired")}
						</p>
						<p className="text-[var(--vscode-descriptionForeground)]">
							{error || t("worktrees.gitRequiredDescription")}
						</p>
					</div>
				) : error ? (
					<div className="flex flex-col items-center justify-center min-h-32 py-8 text-center">
						<AlertCircle className="w-8 h-8 text-[var(--vscode-errorForeground)] mb-2 shrink-0" />
						<p className="text-[var(--vscode-errorForeground)]">{error}</p>
						<VSCodeButton
							appearance="secondary"
							className="mt-3"
							onClick={loadWorktrees}
						>
							{t("worktrees.retry")}
						</VSCodeButton>
					</div>
				) : worktrees.length === 0 ? (
					<div className="flex flex-col items-center justify-center min-h-32 py-8 text-center">
						<GitBranch className="w-8 h-8 text-[var(--vscode-descriptionForeground)] mb-2 shrink-0" />
						<p className="text-[var(--vscode-descriptionForeground)]">
							{t("worktrees.empty")}
						</p>
					</div>
				) : (
					<>
						{/* Worktrees List - current worktree first, then others */}
						<div className="mt-4 flex flex-col gap-2">
							{worktrees.map((worktree) => (
								<div
									className={`p-4 rounded border ${
										worktree.isCurrent
											? "border-[var(--vscode-focusBorder)] bg-[var(--vscode-list-activeSelectionBackground)]"
											: "border-[var(--vscode-panel-border)]"
									}`}
									key={worktree.path}
								>
									{/* Branch name, badges, and action buttons - wraps on small screens */}
									<div className="flex flex-wrap items-center justify-between gap-2 mb-1">
										{/* Left side: branch name and badges */}
										<div className="flex flex-wrap items-center gap-2">
											<div className="flex items-center gap-2">
												<GitBranch className="w-4 h-4 flex-shrink-0 text-[var(--vscode-button-background)]" />
												<span className="font-medium break-all">
													{worktree.branch ||
														(worktree.isDetached
															? t("worktrees.detached")
															: t("common.unknown"))}
												</span>
											</div>
											{isMainWorktree(worktree) && (
												<Tooltip>
													<TooltipTrigger asChild>
														<span className="text-xs px-1.5 py-0.5 rounded bg-[var(--vscode-badge-background)] text-[var(--vscode-badge-foreground)] cursor-help">
															{t("worktrees.primary")}
														</span>
													</TooltipTrigger>
													<TooltipContent side="bottom">
														{t("worktrees.primaryTooltip")}
													</TooltipContent>
												</Tooltip>
											)}
											{worktree.isCurrent && (
												<Tooltip>
													<TooltipTrigger asChild>
														<span className="text-xs px-1.5 py-0.5 rounded bg-[var(--vscode-button-background)] text-[var(--vscode-button-foreground)] cursor-help">
															{t("worktrees.current")}
														</span>
													</TooltipTrigger>
													<TooltipContent side="bottom">
														{t("worktrees.currentTooltip")}
													</TooltipContent>
												</Tooltip>
											)}
											{worktree.isLocked && (
												<span className="text-xs px-1.5 py-0.5 rounded bg-[var(--vscode-inputValidation-warningBackground)] text-[var(--vscode-inputValidation-warningForeground)]">
													{t("worktrees.locked")}
													{worktree.lockReason
														? `: ${worktree.lockReason}`
														: ""}
												</span>
											)}
											{worktree.isPrunable && (
												<span className="text-xs px-1.5 py-0.5 rounded bg-[var(--vscode-inputValidation-warningBackground)] text-[var(--vscode-inputValidation-warningForeground)]">
													{t("worktrees.prunable")}
													{worktree.prunableReason
														? `: ${worktree.prunableReason}`
														: ""}
												</span>
											)}
											{worktree.dirty && (
												<span className="text-xs px-1.5 py-0.5 rounded bg-[var(--vscode-inputValidation-errorBackground)] text-[var(--vscode-errorForeground)]">
													{t("worktrees.dirty")}
												</span>
											)}
										</div>
										{/* Right side: action buttons */}
										<div className="flex items-center gap-1">
											{!worktree.isCurrent && (
												<>
													<Tooltip>
														<TooltipTrigger asChild>
															<VSCodeButton
																appearance="icon"
																onClick={() =>
																	handleSwitchWorktree(worktree.path, false)
																}
															>
																<FolderOpen className="w-4 h-4" />
															</VSCodeButton>
														</TooltipTrigger>
														<TooltipContent side="bottom">
															{t("worktrees.openCurrent")}
														</TooltipContent>
													</Tooltip>
													<Tooltip>
														<TooltipTrigger asChild>
															<VSCodeButton
																appearance="icon"
																onClick={() =>
																	handleSwitchWorktree(worktree.path, true)
																}
															>
																<ExternalLink className="w-4 h-4" />
															</VSCodeButton>
														</TooltipTrigger>
														<TooltipContent side="bottom">
															{t("worktrees.openNew")}
														</TooltipContent>
													</Tooltip>
												</>
											)}
											{!worktree.isCurrent && !isMainWorktree(worktree) && (
												<>
													<Tooltip>
														<TooltipTrigger asChild>
															<VSCodeButton
																appearance="icon"
																onClick={() => openMergeModal(worktree)}
															>
																<GitMerge className="w-4 h-4 text-[var(--vscode-testing-iconPassed)]" />
															</VSCodeButton>
														</TooltipTrigger>
														<TooltipContent side="bottom">
															{t("worktrees.mergeInto", {
																branch: getMainBranch(),
															})}
														</TooltipContent>
													</Tooltip>
													<Tooltip>
														<TooltipTrigger asChild>
															<VSCodeButton
																appearance="icon"
																onClick={() => setDeleteWorktree(worktree)}
															>
																<Trash2 className="w-4 h-4 text-[var(--vscode-errorForeground)]" />
															</VSCodeButton>
														</TooltipTrigger>
														<TooltipContent side="bottom">
															{t("worktrees.deleteThis")}
														</TooltipContent>
													</Tooltip>
												</>
											)}
										</div>
									</div>
									{/* Path */}
									<p className="text-sm text-[var(--vscode-descriptionForeground)] m-0 break-all">
										{worktree.path}
									</p>
									{worktree.statusSummary &&
										worktree.statusSummary !== "clean" && (
											<p className="text-xs text-[var(--vscode-descriptionForeground)] m-0 mt-1">
												{t("worktrees.status")} {worktree.statusSummary}
											</p>
										)}
									{Array.isArray(worktree.statusEntries) &&
										worktree.statusEntries.length > 0 && (
											<ul className="m-0 mt-1 pl-4 text-xs text-[var(--vscode-descriptionForeground)] font-mono">
												{worktree.statusEntries
													.slice(0, 5)
													.map(
														(
															entry: { code?: string; path?: string },
															index: number,
														) => (
															<li
																key={`${entry.code || ""}-${entry.path || ""}-${index}`}
															>
																<span className="text-[var(--vscode-foreground)]">
																	{entry.code || "??"}
																</span>{" "}
																{entry.path || t("worktrees.unknownPath")}
															</li>
														),
													)}
												{worktree.statusEntries.length > 5 && (
													<li>
														{t("worktrees.moreEntries", {
															count: worktree.statusEntries.length - 5,
														})}
													</li>
												)}
											</ul>
										)}
								</div>
							))}
						</div>
					</>
				)}
			</div>

			{/* Fixed Bottom - New Worktree Button */}
			{isGitRepo && !isMultiRoot && !isSubfolder && (
				<div
					className="flex-none px-5 py-3"
					style={{
						borderTop: "1px solid var(--vscode-panel-border)",
					}}
				>
					<VSCodeButton
						disabled={isLoading}
						onClick={() => setShowCreateForm(true)}
						style={{ width: "100%" }}
					>
						<Plus className="w-4 h-4 mr-1" />
						{t("worktrees.new")}
					</VSCodeButton>
				</div>
			)}

			<WorktreeOperationDialogs controller={controller} />
		</div>
	);
};

export default memo(WorktreesView);
