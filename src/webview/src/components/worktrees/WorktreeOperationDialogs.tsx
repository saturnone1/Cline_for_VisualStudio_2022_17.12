import { VSCodeButton, VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react";
import { AlertCircle, Check, GitMerge, Loader2, X } from "lucide-react";
import CreateWorktreeModal from "./CreateWorktreeModal";
import DeleteWorktreeModal from "./DeleteWorktreeModal";
import type { useWorktreesViewController } from "./useWorktreesViewController";

type Controller = ReturnType<typeof useWorktreesViewController>;

export function WorktreeOperationDialogs({
	controller,
}: {
	controller: Controller;
}) {
	const {
		t,
		showCreateForm,
		setShowCreateForm,
		setIsOperating,
		setOperationMessage,
		loadWorktrees,
		deleteWorktree,
		setDeleteWorktree,
		handleDeleteWorktree,
		pendingSwitch,
		setPendingSwitch,
		selectedSolutionPath,
		setSelectedSolutionPath,
		handleSwitchWorktree,
		mergeWorktree,
		isMerging,
		closeMergeModal,
		mergeResult,
		handleAskClineToResolve,
		getMainBranch,
		deleteAfterMerge,
		setDeleteAfterMerge,
		mergeError,
		handleMergeWorktree,
	} = controller;

	return (
		<>
			{/* Create Worktree Modal */}
			<CreateWorktreeModal
				onClose={() => setShowCreateForm(false)}
				onOperationChange={setIsOperating}
				onSuccess={async (message) => {
					setOperationMessage(message || t("worktrees.created"));
					await loadWorktrees();
				}}
				open={showCreateForm}
			/>

			{/* Delete Worktree Modal */}
			<DeleteWorktreeModal
				branchName={deleteWorktree?.branch || ""}
				onClose={() => setDeleteWorktree(null)}
				onConfirm={(deleteBranch, force) =>
					handleDeleteWorktree(
						deleteWorktree!.path,
						deleteBranch,
						deleteWorktree!.branch,
						force,
					)
				}
				open={!!deleteWorktree}
				statusSummary={deleteWorktree?.statusSummary || ""}
				worktreePath={deleteWorktree?.path || ""}
			/>

			{/* Solution picker for worktrees with multiple .sln files */}
			{pendingSwitch && (
				<div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
					<div className="bg-[var(--vscode-editor-background)] border border-[var(--vscode-panel-border)] rounded-lg p-5 w-[520px] max-w-[90vw]">
						<h4 className="m-0 mb-2">{t("worktrees.chooseSolution")}</h4>
						<p className="text-sm text-[var(--vscode-descriptionForeground)] mt-0">
							{t("worktrees.chooseSolutionDescription")}
						</p>
						<select
							className="w-full bg-[var(--vscode-dropdown-background)] text-[var(--vscode-dropdown-foreground)] border border-[var(--vscode-dropdown-border)] rounded px-2 py-1"
							onChange={(event) => setSelectedSolutionPath(event.target.value)}
							value={selectedSolutionPath}
						>
							{pendingSwitch.solutionCandidates.map((candidate) => (
								<option key={candidate} value={candidate}>
									{candidate}
								</option>
							))}
						</select>
						<div className="flex justify-end gap-2 mt-4">
							<VSCodeButton
								appearance="secondary"
								onClick={() => setPendingSwitch(null)}
							>
								{t("common.cancel")}
							</VSCodeButton>
							<VSCodeButton
								disabled={!selectedSolutionPath}
								onClick={() =>
									handleSwitchWorktree(
										pendingSwitch.path,
										pendingSwitch.newWindow,
										selectedSolutionPath,
									)
								}
							>
								{t("worktrees.open")}
							</VSCodeButton>
						</div>
					</div>
				</div>
			)}

			{/* Merge Worktree Modal */}
			{mergeWorktree && (
				<div
					className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
					onClick={(e) => {
						if (e.target === e.currentTarget && !isMerging) {
							closeMergeModal();
						}
					}}
				>
					<div className="bg-[var(--vscode-editor-background)] border border-[var(--vscode-panel-border)] rounded-lg p-5 w-[450px] max-w-[90vw] relative">
						{/* Close button */}
						<button
							className="absolute top-3 right-3 p-1 rounded hover:bg-[var(--vscode-toolbar-hoverBackground)] text-[var(--vscode-descriptionForeground)] hover:text-[var(--vscode-foreground)] cursor-pointer"
							disabled={isMerging}
							onClick={closeMergeModal}
							type="button"
						>
							<X className="w-4 h-4" />
						</button>

						<div className="flex items-center gap-2 mb-2">
							<GitMerge className="w-5 h-5 text-[var(--vscode-testing-iconPassed)]" />
							<h4 className="m-0 pr-6">{t("worktrees.mergeTitle")}</h4>
						</div>

						{/* Success state */}
						{mergeResult?.success ? (
							<div className="flex flex-col gap-4">
								<div className="flex items-center gap-2 p-3 rounded bg-[var(--vscode-testing-iconPassed)]/10 border border-[var(--vscode-testing-iconPassed)]">
									<Check className="w-5 h-5 text-[var(--vscode-testing-iconPassed)]" />
									<p className="text-sm m-0">{mergeResult.message}</p>
								</div>
								<div className="flex justify-end">
									<VSCodeButton onClick={closeMergeModal}>
										{t("common.done")}
									</VSCodeButton>
								</div>
							</div>
						) : mergeResult?.hasConflicts ? (
							/* Conflict state */
							<div className="flex flex-col gap-4">
								<div className="flex items-start gap-2 p-3 rounded bg-[var(--vscode-inputValidation-warningBackground)] border border-[var(--vscode-inputValidation-warningBorder)]">
									<AlertCircle className="w-5 h-5 flex-shrink-0 text-[var(--vscode-inputValidation-warningForeground)] mt-0.5" />
									<div>
										<p className="text-sm font-medium m-0 mb-1">
											{t("worktrees.conflictsTitle")}
										</p>
										<p className="text-xs text-[var(--vscode-descriptionForeground)] m-0 mb-2 break-all">
											{mergeResult.sourceBranch}
											{" -> "}
											{mergeResult.targetBranch}
											{mergeResult.targetWorktreePath
												? ` at ${mergeResult.targetWorktreePath}`
												: ""}
										</p>
										<p className="text-sm text-[var(--vscode-descriptionForeground)] m-0 mb-2">
											{t("worktrees.conflictsDescription")}
										</p>
										<ul className="m-0 pl-4 text-sm font-mono text-[var(--vscode-descriptionForeground)]">
											{mergeResult.conflictingFiles.slice(0, 3).map((file) => (
												<li key={file}>{file}</li>
											))}
											{mergeResult.conflictingFiles.length > 3 && (
												<li className="text-[var(--vscode-descriptionForeground)]">
													{t("worktrees.moreEntries", {
														count: mergeResult.conflictingFiles.length - 3,
													})}
												</li>
											)}
										</ul>
										{Array.isArray(mergeResult.recoveryCommands) &&
											mergeResult.recoveryCommands.length > 0 && (
												<div className="mt-3">
													<p className="text-xs text-[var(--vscode-descriptionForeground)] m-0 mb-1">
														{t("worktrees.recoveryCommands")}
													</p>
													<ul className="m-0 pl-4 text-xs font-mono text-[var(--vscode-descriptionForeground)]">
														{mergeResult.recoveryCommands.map(
															(command: string) => (
																<li key={command}>{command}</li>
															),
														)}
													</ul>
												</div>
											)}
									</div>
								</div>

								<div className="flex flex-col gap-2">
									<VSCodeButton
										onClick={handleAskClineToResolve}
										style={{ width: "100%" }}
									>
										{t("worktrees.askResolve")}
									</VSCodeButton>
									<VSCodeButton
										appearance="secondary"
										onClick={closeMergeModal}
										style={{ width: "100%" }}
									>
										{t("worktrees.resolveManually")}
									</VSCodeButton>
								</div>
							</div>
						) : (
							/* Default state - confirm merge */
							<div className="flex flex-col gap-4">
								<p className="text-sm text-[var(--vscode-descriptionForeground)] m-0">
									{t("worktrees.mergeConfirmPrefix")}{" "}
									<code className="bg-[var(--vscode-textCodeBlock-background)] px-1 rounded">
										{mergeWorktree.branch}
									</code>{" "}
									{t("worktrees.mergeConfirmMiddle")}{" "}
									<code className="bg-[var(--vscode-textCodeBlock-background)] px-1 rounded">
										{getMainBranch()}
									</code>
									.
								</p>

								<label className="flex items-center gap-2 cursor-pointer">
									<VSCodeCheckbox
										checked={deleteAfterMerge}
										onChange={(e) =>
											setDeleteAfterMerge(
												(e.target as HTMLInputElement).checked,
											)
										}
									/>
									<span className="text-sm">
										{t("worktrees.deleteAfterMerge")}
									</span>
								</label>

								{mergeError && (
									<div className="flex items-start gap-2 p-3 rounded bg-[var(--vscode-inputValidation-errorBackground)] border border-[var(--vscode-inputValidation-errorBorder)]">
										<AlertCircle className="w-4 h-4 flex-shrink-0 text-[var(--vscode-errorForeground)] mt-0.5" />
										<p className="text-sm text-[var(--vscode-errorForeground)] m-0">
											{mergeError}
										</p>
									</div>
								)}

								<div className="flex justify-end gap-2">
									<VSCodeButton
										appearance="secondary"
										disabled={isMerging}
										onClick={closeMergeModal}
									>
										{t("common.cancel")}
									</VSCodeButton>
									<VSCodeButton
										disabled={isMerging}
										onClick={handleMergeWorktree}
									>
										{isMerging ? (
											<>
												<Loader2 className="w-4 h-4 mr-1 animate-spin" />
												{t("worktrees.merging")}
											</>
										) : (
											<>
												<GitMerge className="w-4 h-4 mr-1" />
												{t("worktrees.merge")}
											</>
										)}
									</VSCodeButton>
								</div>
							</div>
						)}
					</div>
				</div>
			)}
		</>
	);
}
