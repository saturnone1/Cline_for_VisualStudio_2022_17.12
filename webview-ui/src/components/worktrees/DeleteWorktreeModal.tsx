import { VSCodeButton, VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { AlertTriangle, Loader2, X } from "lucide-react"
import { memo, useCallback, useState } from "react"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/i18n"

interface DeleteWorktreeModalProps {
	open: boolean
	onClose: () => void
	onConfirm: (deleteBranch: boolean, force: boolean) => Promise<string | null>
	worktreePath: string
	branchName: string
	statusSummary?: string
}

const DeleteWorktreeModal = ({ open, onClose, onConfirm, worktreePath, branchName, statusSummary = "" }: DeleteWorktreeModalProps) => {
	const { t } = useI18n()
	const [isDeleting, setIsDeleting] = useState(false)
	const [deleteBranch, setDeleteBranch] = useState(false)
	const [forceDelete, setForceDelete] = useState(false)
	const [deleteError, setDeleteError] = useState("")

	const handleDelete = useCallback(async () => {
		setIsDeleting(true)
		setDeleteError("")
		try {
			const failureMessage = await onConfirm(deleteBranch, forceDelete)
			if (!failureMessage) {
				onClose()
			} else {
				setDeleteError(failureMessage)
			}
		} finally {
			setIsDeleting(false)
		}
	}, [onConfirm, onClose, deleteBranch, forceDelete])

	if (!open) {
		return null
	}

	return (
		<div
			className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
			onClick={(e) => {
				if (e.target === e.currentTarget && !isDeleting) {
					onClose()
				}
			}}>
			<div className="bg-[var(--vscode-editor-background)] border border-[var(--vscode-panel-border)] rounded-lg p-5 w-[400px] max-w-[90vw] relative">
				{/* Close button */}
				<button
					className="absolute top-3 right-3 p-1 rounded hover:bg-[var(--vscode-toolbar-hoverBackground)] text-[var(--vscode-descriptionForeground)] hover:text-[var(--vscode-foreground)] cursor-pointer disabled:opacity-50"
					disabled={isDeleting}
					onClick={onClose}
					type="button">
					<X className="w-4 h-4" />
				</button>

				{/* Title row with icon */}
				<div className="flex items-center gap-2 mb-3 pr-6">
					<AlertTriangle className="w-5 h-5 text-[var(--vscode-errorForeground)]" />
					<h4 className="m-0">{t("worktrees.deleteTitle")}</h4>
				</div>

				{/* Content */}
				<p className="text-sm text-[var(--vscode-descriptionForeground)] mt-0 mb-3">
					{t("worktrees.deleteDescription")}{" "}
					<span className="font-semibold text-[var(--vscode-foreground)] break-all">{worktreePath}</span>
				</p>
				{statusSummary && statusSummary !== "clean" && (
					<p className="text-sm text-[var(--vscode-inputValidation-warningForeground)] mt-0 mb-3">
						{t("worktrees.currentStatus")} {statusSummary}
					</p>
				)}

				<label className="flex items-center gap-2 cursor-pointer mb-3">
					<VSCodeCheckbox
						checked={deleteBranch}
						onChange={(e) => setDeleteBranch((e.target as HTMLInputElement).checked)}
					/>
					<span className="text-sm">{t("worktrees.deleteBranch", { branch: branchName })}</span>
				</label>
				<label className="flex items-center gap-2 cursor-pointer mb-3">
					<VSCodeCheckbox
						checked={forceDelete}
						onChange={(e) => setForceDelete((e.target as HTMLInputElement).checked)}
					/>
					<span className="text-sm">{t("worktrees.forceDelete")}</span>
				</label>

				{(deleteBranch || forceDelete) && (
					<p className="text-sm text-[var(--vscode-inputValidation-warningForeground)] mt-0 mb-3">
						{t("worktrees.deleteWarning")}
					</p>
				)}
				{deleteError && (
					<p className="text-sm text-[var(--vscode-errorForeground)] mt-0 mb-3">{deleteError}</p>
				)}

				{/* Buttons */}
				<div className="flex justify-end gap-2">
					<VSCodeButton appearance="secondary" disabled={isDeleting} onClick={onClose}>
						{t("common.cancel")}
					</VSCodeButton>
					<Button disabled={isDeleting} onClick={handleDelete} variant="danger">
						{isDeleting ? (
							<>
								<Loader2 className="w-4 h-4 mr-1 animate-spin" />
								{t("worktrees.deleting")}
							</>
						) : (
							t("worktrees.delete")
						)}
					</Button>
				</div>
			</div>
		</div>
	)
}

export default memo(DeleteWorktreeModal)
