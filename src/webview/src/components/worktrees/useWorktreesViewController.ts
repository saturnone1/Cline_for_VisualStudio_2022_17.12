import { EmptyRequest } from "@shared/proto/cline/common";
import { NewTaskRequest } from "@shared/proto/cline/task";
import type {
	MergeWorktreeResult,
	Worktree as WorktreeProto,
} from "@shared/proto/cline/worktree";
import {
	CreateWorktreeIncludeRequest,
	DeleteWorktreeRequest,
	MergeWorktreeRequest,
	SwitchWorktreeRequest,
} from "@shared/proto/cline/worktree";
import { useCallback, useEffect, useRef, useState } from "react";
import { useExtensionState } from "@/context/ExtensionStateContext";
import { useI18n } from "@/i18n";
import {
	FileServiceClient,
	TaskServiceClient,
	WorktreeServiceClient,
} from "@/services/grpcClient";

export type WorktreesViewControllerProps = {
	onDone: () => void;
};

const WORKTREE_REFRESH_INTERVAL_MS = 3_000;

export function useWorktreesViewController({
	onDone,
}: WorktreesViewControllerProps) {
	const { environment } = useExtensionState();
	const { language, t } = useI18n();
	const [worktrees, setWorktrees] = useState<WorktreeProto[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [isGitRepo, setIsGitRepo] = useState(true);
	const [isMultiRoot, setIsMultiRoot] = useState(false);
	const [isSubfolder, setIsSubfolder] = useState(false);
	const [gitRootPath, setGitRootPath] = useState("");
	const [errorKind, setErrorKind] = useState("");
	const [showCreateForm, setShowCreateForm] = useState(false);
	const [deleteWorktree, setDeleteWorktree] = useState<WorktreeProto | null>(
		null,
	);
	const [operationMessage, setOperationMessage] = useState<string | null>(null);
	const [isOperating, setIsOperating] = useState(false);
	const [pendingSwitch, setPendingSwitch] = useState<{
		path: string;
		newWindow: boolean;
		solutionCandidates: string[];
	} | null>(null);
	const [selectedSolutionPath, setSelectedSolutionPath] = useState("");

	// Merge worktree state
	const [mergeWorktree, setMergeWorktree] = useState<WorktreeProto | null>(
		null,
	);
	const [isMerging, setIsMerging] = useState(false);
	const [mergeError, setMergeError] = useState<string | null>(null);
	const [mergeResult, setMergeResult] = useState<MergeWorktreeResult | null>(
		null,
	);
	const [deleteAfterMerge, setDeleteAfterMerge] = useState(true);

	// .worktreeinclude status
	const [hasWorktreeInclude, setHasWorktreeInclude] = useState(false);
	const [hasGitignore, setHasGitignore] = useState(false);
	const [gitignoreContent, setGitignoreContent] = useState("");
	const [isCreatingWorktreeInclude, setIsCreatingWorktreeInclude] =
		useState(false);
	const worktreeLoadRef = useRef<Promise<void> | null>(null);

	// Check if a worktree is the main/primary worktree (first one, typically the original clone)
	const isMainWorktree = useCallback(
		(worktree: WorktreeProto) => {
			// The main worktree is typically the first one listed and is where .git directory lives
			// It's also usually the one that's marked as "bare" or is the original clone location
			if (worktrees.length === 0) return false;
			return worktree.path === worktrees[0]?.path || worktree.isBare;
		},
		[worktrees],
	);

	// Load worktrees - only updates state if data changed to prevent flickering
	const loadWorktrees = useCallback(() => {
		if (worktreeLoadRef.current) {
			return worktreeLoadRef.current;
		}
		const request = (async () => {
		try {
			const response = await WorktreeServiceClient.listWorktrees(
				EmptyRequest.create({}),
			);
			// Only update state if data actually changed (prevents flickering)
			setWorktrees((prev) => {
				const newData = JSON.stringify(response.worktrees);
				const oldData = JSON.stringify(prev);
				return newData === oldData ? prev : response.worktrees;
			});
			setIsGitRepo((prev) =>
				prev === response.isGitRepo ? prev : response.isGitRepo,
			);
			setIsMultiRoot((prev) =>
				prev === response.isMultiRoot ? prev : response.isMultiRoot,
			);
			setIsSubfolder((prev) =>
				prev === response.isSubfolder ? prev : response.isSubfolder,
			);
			setGitRootPath((prev) =>
				prev === response.gitRootPath ? prev : response.gitRootPath,
			);
			setErrorKind((prev) =>
				prev === response.errorKind ? prev : response.errorKind || "",
			);
			setError(response.error || null);
		} catch (err) {
			setError(err instanceof Error ? err.message : t("worktrees.loadFailed"));
		} finally {
			setIsLoading(false);
		}
		})();
		worktreeLoadRef.current = request;
		const clear = () => {
			if (worktreeLoadRef.current === request) worktreeLoadRef.current = null;
		};
		request.then(clear, clear);
		return request;
	}, [t]);

	// Load .worktreeinclude status
	const loadWorktreeIncludeStatus = useCallback(async () => {
		try {
			const status = await WorktreeServiceClient.getWorktreeIncludeStatus(
				EmptyRequest.create({}),
			);
			setHasWorktreeInclude(status.exists);
			setHasGitignore(status.hasGitignore);
			setGitignoreContent(status.gitignoreContent);
		} catch (err) {
			console.error("Failed to load worktree include status:", err);
		}
	}, []);

	// Create .worktreeinclude file and open it in editor
	const handleCreateWorktreeInclude = useCallback(async () => {
		setIsCreatingWorktreeInclude(true);
		try {
			const result = await WorktreeServiceClient.createWorktreeInclude(
				CreateWorktreeIncludeRequest.create({
					content: gitignoreContent,
				}),
			);
			if (result.success) {
				setHasWorktreeInclude(true);
				// Open the file in the editor
				await FileServiceClient.openFileRelativePath({
					value: ".worktreeinclude",
				});
			} else {
				setError(result.message);
			}
		} catch (err) {
			setError(
				err instanceof Error ? err.message : t("worktrees.includeCreateFailed"),
			);
		} finally {
			setIsCreatingWorktreeInclude(false);
		}
	}, [gitignoreContent, t]);

	// Initial load
	useEffect(() => {
		loadWorktrees();
		loadWorktreeIncludeStatus();
	}, [loadWorktrees, loadWorktreeIncludeStatus]);

	// Poll serially so a slow host request cannot overwrite a newer response.
	useEffect(() => {
		if (isOperating) {
			return;
		}
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const poll = async () => {
			await loadWorktrees().catch(() => undefined);
			if (!cancelled) timer = setTimeout(poll, WORKTREE_REFRESH_INTERVAL_MS);
		};
		timer = setTimeout(poll, WORKTREE_REFRESH_INTERVAL_MS);
		return () => {
			cancelled = true;
			if (timer) clearTimeout(timer);
		};
	}, [isOperating, loadWorktrees]);

	const handleDeleteWorktree = useCallback(
		async (
			path: string,
			deleteBranch: boolean,
			branchName: string,
			force: boolean,
		) => {
			setIsOperating(true);
			try {
				const result = await WorktreeServiceClient.deleteWorktree(
					DeleteWorktreeRequest.create({
						path,
						force,
						deleteBranch,
						branchName,
					}),
				);

				if (!result.success) {
					setError(result.message);
					return result.message || t("worktrees.deleteFailed");
				} else {
					setOperationMessage(result.message || t("worktrees.deleted"));
					if (result.warning) {
						setError(result.warning);
					}
					await loadWorktrees();
					return null;
				}
			} catch (err) {
				const message =
					err instanceof Error ? err.message : t("worktrees.deleteFailed");
				setError(message);
				return message;
			} finally {
				setIsOperating(false);
			}
		},
		[loadWorktrees, t],
	);

	const handleSwitchWorktree = useCallback(
		async (path: string, newWindow: boolean, solutionPath = "") => {
			setIsOperating(true);
			try {
				const result = await WorktreeServiceClient.switchWorktree(
					SwitchWorktreeRequest.create({
						path,
						newWindow,
						solutionPath,
					}),
				);
				if (!result.success) {
					if (
						Array.isArray(result.solutionCandidates) &&
						result.solutionCandidates.length > 1
					) {
						setPendingSwitch({
							path,
							newWindow,
							solutionCandidates: result.solutionCandidates,
						});
						setSelectedSolutionPath(result.solutionCandidates[0] || "");
						setError(null);
						return;
					}
					setError(result.message || t("worktrees.switchFailed"));
				} else {
					setError(null);
					setPendingSwitch(null);
					setOperationMessage(result.message || t("worktrees.opened"));
				}
			} catch (err) {
				setError(
					err instanceof Error ? err.message : t("worktrees.switchFailed"),
				);
			} finally {
				setIsOperating(false);
			}
		},
		[t],
	);

	// Get the main branch name (first worktree's branch, usually main/master)
	const getMainBranch = useCallback(() => {
		if (worktrees.length === 0) return "main";
		return worktrees[0]?.branch || "main";
	}, [worktrees]);

	// Open merge modal for a worktree
	const openMergeModal = useCallback((worktree: WorktreeProto) => {
		setMergeWorktree(worktree);
		setMergeError(null);
		setMergeResult(null);
		setDeleteAfterMerge(true);
	}, []);

	// Close merge modal
	const closeMergeModal = useCallback(() => {
		setMergeWorktree(null);
		setMergeError(null);
		setMergeResult(null);
	}, []);

	// Handle merge
	const handleMergeWorktree = useCallback(async () => {
		if (!mergeWorktree) return;

		setIsMerging(true);
		setIsOperating(true);
		setMergeError(null);
		setMergeResult(null);

		try {
			const result = await WorktreeServiceClient.mergeWorktree(
				MergeWorktreeRequest.create({
					worktreePath: mergeWorktree.path,
					targetBranch: getMainBranch(),
					deleteAfterMerge,
				}),
			);

			setMergeResult(result);

			if (result.success) {
				setOperationMessage(result.message || t("worktrees.merged"));
				// Reload worktrees to reflect changes
				await loadWorktrees();
			} else if (!result.hasConflicts) {
				setMergeError(result.message);
			}
		} catch (err) {
			setMergeError(
				err instanceof Error ? err.message : t("worktrees.mergeFailed"),
			);
		} finally {
			setIsMerging(false);
			setIsOperating(false);
		}
	}, [mergeWorktree, getMainBranch, deleteAfterMerge, loadWorktrees, t]);

	// Ask the active agent to resolve conflicts
	const handleAskClineToResolve = useCallback(async () => {
		if (!mergeResult || !mergeResult.hasConflicts) return;

		const conflictList = mergeResult.conflictingFiles.join(", ");
		const prompt =
			language === "ko"
				? `${mergeResult.recoveryPrompt || `워크트리 '${mergeResult.sourceWorktreePath || mergeWorktree?.path}'의 브랜치 '${mergeResult.sourceBranch}'를 '${mergeResult.targetBranch}'로 병합하려고 했지만 '${mergeResult.targetWorktreePath || "기본 워크트리"}'에서 다음 파일에 병합 충돌이 발생했습니다: ${conflictList}`}

워크트리 백엔드가 제안한 복구 명령:
${Array.isArray(mergeResult.recoveryCommands) ? mergeResult.recoveryCommands.map((command: string) => `- ${command}`).join("\n") : "- git status --short\n- git diff --name-only --diff-filter=U\n- git merge --abort"}

충돌 파일을 확인하고 병합 충돌을 해결한 뒤, 필요하면 해결 커밋까지 만들어 주세요. 병합이 완료된 것을 확인하기 전에는 워크트리를 삭제하지 마세요.`
				: `${mergeResult.recoveryPrompt || `I tried to merge worktree '${mergeResult.sourceWorktreePath || mergeWorktree?.path}' from branch '${mergeResult.sourceBranch}' into '${mergeResult.targetBranch}' at '${mergeResult.targetWorktreePath || "the main worktree"}', but there are merge conflicts in the following files: ${conflictList}`}

Recovery commands suggested by the worktree backend:
${Array.isArray(mergeResult.recoveryCommands) ? mergeResult.recoveryCommands.map((command: string) => `- ${command}`).join("\n") : "- git status --short\n- git diff --name-only --diff-filter=U\n- git merge --abort"}

Please help me inspect the conflict files, resolve the merge, commit the resolution if needed, and only delete the worktree after confirming the merge is complete.`;

		try {
			// Create a new task with this prompt
			await TaskServiceClient.newTask(
				NewTaskRequest.create({
					text: prompt,
					workspacePath: mergeResult.targetWorktreePath || mergeWorktree?.path,
					worktreePath: mergeWorktree?.path,
				}),
			);
			closeMergeModal();
			// Close worktrees view to show the chat with the new task
			onDone();
		} catch (err) {
			setMergeError(
				err instanceof Error ? err.message : t("worktrees.taskCreateFailed"),
			);
		}
	}, [mergeResult, mergeWorktree, closeMergeModal, onDone, language, t]);

	return {
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
	};
}
