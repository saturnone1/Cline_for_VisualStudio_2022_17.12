import { flip, offset, shift, useFloating } from "@floating-ui/react"
import { BookmarkIcon } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Button } from "@/components/ui/button"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useI18n } from "@/i18n"
import { cn } from "@/lib/utils"
import {
	AdditionalOptions,
	ButtonGroup,
	CheckpointButton,
	CheckpointContainer,
	DottedLine,
	MoreOptionsToggle,
	PrimaryRestoreOption,
	RestoreConfirmTooltip,
	RestoreOption,
} from "./CheckpointControl.styles"
import { useCheckpointActions } from "./useCheckpointActions"

interface CheckpointControlProps {
	messageTs?: number
	isCheckpointCheckedOut?: boolean
}

export function CheckpointControl({ messageTs, isCheckpointCheckedOut }: CheckpointControlProps) {
	const [showRestoreConfirm, setShowRestoreConfirm] = useState(false)
	const [showMoreOptions, setShowMoreOptions] = useState(false)
	const closeMenuTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
	const { checkpointManagerErrorMessage, enableCheckpointsSetting, onRelinquishControl } = useExtensionState()
	const { t } = useI18n()
	const actions = useCheckpointActions(messageTs)
	const canUseActions = enableCheckpointsSetting && !checkpointManagerErrorMessage
	const { refs, floatingStyles, update, placement } = useFloating({
		placement: "bottom-end",
		middleware: [offset({ mainAxis: 8, crossAxis: 10 }), flip(), shift()],
	})

	const cancelClose = useCallback(() => {
		if (closeMenuTimer.current) clearTimeout(closeMenuTimer.current)
		closeMenuTimer.current = null
	}, [])
	const scheduleClose = useCallback(() => {
		cancelClose()
		closeMenuTimer.current = setTimeout(() => setShowRestoreConfirm(false), 350)
	}, [cancelClose])

	useEffect(() => () => cancelClose(), [cancelClose])
	useEffect(() => onRelinquishControl(() => {
		setShowRestoreConfirm(false)
		setShowMoreOptions(false)
	}), [onRelinquishControl])
	useEffect(() => {
		const handleScroll = () => update()
		window.addEventListener("scroll", handleScroll, true)
		return () => window.removeEventListener("scroll", handleScroll, true)
	}, [update])
	useEffect(() => {
		if (showRestoreConfirm) update()
	}, [showRestoreConfirm, update])

	return (
		<CheckpointContainer
			$isCheckedOut={isCheckpointCheckedOut}
			$isMenuOpen={showRestoreConfirm}
			onMouseEnter={cancelClose}
			onMouseLeave={scheduleClose}>
			<BookmarkIcon className={cn("size-2 shrink-0 text-description", { "text-link": isCheckpointCheckedOut })} />
			<span className={cn("shrink-0 text-[10px] text-description", { "text-link": isCheckpointCheckedOut })}>
				{isCheckpointCheckedOut ? t("checkpoint.restored") : t("checkpoint.label")}
			</span>
			<DottedLine $isCheckedOut={isCheckpointCheckedOut} className="hover-show-inverse" />
			{canUseActions && (
				<div className="hover-content">
					<DottedLine $isCheckedOut={isCheckpointCheckedOut} />
					<ButtonGroup>
						<CheckpointButton
							$isCheckedOut={isCheckpointCheckedOut}
							disabled={actions.comparePending}
							onClick={actions.compare}>
							{t("checkpoint.compare")}
						</CheckpointButton>
						<DottedLine $isCheckedOut={isCheckpointCheckedOut} $small />
						<div ref={refs.setReference} style={{ marginTop: -2, position: "relative" }}>
							<CheckpointButton
								$isActive={showRestoreConfirm}
								$isCheckedOut={isCheckpointCheckedOut}
								onClick={() => setShowRestoreConfirm(true)}>
								{t("checkpoint.restore")}
							</CheckpointButton>
						</div>
					</ButtonGroup>
				</div>
			)}
			{showRestoreConfirm && createPortal(
				<RestoreConfirmTooltip
					data-placement={placement}
					onMouseEnter={cancelClose}
					onMouseLeave={scheduleClose}
					ref={refs.setFloating}
					style={floatingStyles}>
					<PrimaryRestoreOption>
						<Button disabled={actions.restoreBothPending} onClick={actions.restoreBoth}>
							<i className="codicon codicon-debug-restart mr-1.5" />
							{t("checkpoint.restoreFilesAndTask")}
						</Button>
						<p>{t("checkpoint.restoreFilesAndTaskHelp")}</p>
					</PrimaryRestoreOption>
					<MoreOptionsToggle onClick={() => setShowMoreOptions((visible) => !visible)}>
						{t("checkpoint.moreOptions")}
						<i className={`codicon codicon-chevron-${showMoreOptions ? "up" : "down"} ml-1 text-[10px]`} />
					</MoreOptionsToggle>
					{showMoreOptions && (
						<AdditionalOptions>
							<RestoreOption>
								<Button
									disabled={actions.restoreWorkspacePending || isCheckpointCheckedOut}
									onClick={actions.restoreWorkspace}
									variant="secondary">
									<i className="codicon codicon-file-symlink-directory mr-1.5" />
									{t("checkpoint.restoreFilesOnly")}
								</Button>
								<p>{t("checkpoint.restoreFilesOnlyHelp")}</p>
							</RestoreOption>
							<RestoreOption>
								<Button disabled={actions.restoreTaskPending} onClick={actions.restoreTask} variant="secondary">
									<i className="codicon codicon-comment-discussion mr-1.5" />
									{t("checkpoint.restoreTaskOnly")}
								</Button>
								<p>{t("checkpoint.restoreTaskOnlyHelp")}</p>
							</RestoreOption>
						</AdditionalOptions>
					)}
				</RestoreConfirmTooltip>,
				document.body,
			)}
		</CheckpointContainer>
	)
}
