import { HistoryItem } from "@shared/HistoryItem"
import { StringRequest } from "@shared/proto/cline/common"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import {
	ArrowDownIcon,
	ArrowLeftIcon,
	ArrowRightIcon,
	ArrowUpIcon,
	ChevronsDownUpIcon,
	ChevronsUpDownIcon,
	DownloadIcon,
	StarIcon,
	TrashIcon,
} from "lucide-react"
import { memo, useCallback, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/i18n"
import { cn } from "@/lib/utils"
import { TaskServiceClient } from "@/services/grpcClient"
import { formatLargeNumber, formatSize } from "@/utils/format"

type HistoryViewItemProps = {
	item: HistoryItem
	index: number
	selectedItems: string[]
	pendingFavoriteToggles: Record<string, boolean>
	handleDeleteHistoryItem: (id: string) => void
	toggleFavorite: (id: string, isCurrentlyFavorited: boolean) => void
	handleHistorySelect: (itemId: string, checked: boolean) => void
	handleTaskOpened: () => void
}

const HistoryViewItem = ({
	item,
	pendingFavoriteToggles,
	handleDeleteHistoryItem,
	toggleFavorite,
	handleHistorySelect,
	handleTaskOpened,
	selectedItems,
}: HistoryViewItemProps) => {
	const [expanded, setExpanded] = useState(false)
	const [isOpening, setIsOpening] = useState(false)
	const [openError, setOpenError] = useState<string | null>(null)
	const { language, t } = useI18n()

	const isFavoritedItem = useMemo(
		() => pendingFavoriteToggles[item.id] ?? item.isFavorited,
		[item.id, item.isFavorited, pendingFavoriteToggles],
	)

	const handleShowTaskWithId = useCallback(
		(id: string) => {
			if (isOpening) {
				return
			}
			setIsOpening(true)
			setOpenError(null)
			TaskServiceClient.showTaskWithId(StringRequest.create({ value: id }))
				.then(handleTaskOpened)
				.catch((error) => {
					console.error("Error showing task:", error)
					setOpenError(t("history.openFailed"))
				})
				.finally(() => setIsOpening(false))
		},
		[handleTaskOpened, isOpening, t],
	)

	const formatDate = useCallback((timestamp: number) => {
		const date = new Date(timestamp)
		const today = new Date()
		const isToday = today.toDateString() === date.toDateString()

		return date
			.toLocaleString(
				language === "ko" ? "ko-KR" : "en-US",
				isToday
					? {
							hour: "numeric",
							minute: "2-digit",
							hour12: true,
						}
					: {
							month: "long",
							day: "numeric",
							hour: "numeric",
							minute: "2-digit",
							hour12: true,
						},
			)
			.replace(", ", " ")
			.replace(" at", ",")
	}, [])

	return (
		<div className="history-item group mb-1 flex min-w-0 cursor-pointer border-b border-accent/10 hover:bg-list-hover" key={item.id}>
			<VSCodeCheckbox
				checked={selectedItems.includes(item.id)}
				className="mt-3 shrink-0 self-start pl-3 pr-1"
				onClick={(e) => {
					e.preventDefault()
					e.stopPropagation()
					const checked = (e.target as HTMLInputElement).checked
					handleHistorySelect(item.id, checked)
				}}
			/>

			<div
				className={cn("relative flex min-w-0 flex-grow flex-col gap-2 py-2 pl-2 pr-2", {
					"opacity-80": isOpening,
				})}
				onClick={(e) => {
					e.stopPropagation()
					handleShowTaskWithId(item.id)
				}}>
				<div className="flex min-w-0 items-center gap-1">
					<div className="line-clamp-1 overflow-hidden break-words whitespace-pre-wrap flex-1 min-w-0">
						<span className="ph-no-capture">{item.task}</span>
					</div>
					<div className="flex shrink-0 items-center gap-0.5">
						<Button
							aria-label={t("history.continue")}
							className="size-7 shrink-0 p-0"
							disabled={isOpening}
							onClick={(e) => {
								e.stopPropagation()
								handleShowTaskWithId(item.id)
							}}
							title={isOpening ? t("history.opening") : t("history.continue")}
							variant="icon">
							{isOpening ? <span className="codicon codicon-loading animate-spin" /> : <ArrowRightIcon className="!size-3.5" />}
						</Button>
						<Button
							aria-label={t("history.delete")}
							className="size-7 shrink-0 p-0"
							disabled={isFavoritedItem}
							onClick={(e) => {
								e.stopPropagation()
								handleDeleteHistoryItem(item.id)
							}}
							title={isFavoritedItem ? t("history.removeFavoriteBeforeDelete") : t("history.delete")}
							variant="icon">
							<TrashIcon className="!size-3.5 stroke-1" />
						</Button>
						<Button
							aria-label={isFavoritedItem ? t("history.removeFavorite") : t("history.addFavorite")}
							className="size-7 shrink-0 p-0"
							disabled={pendingFavoriteToggles[item.id] !== undefined}
							onClick={(e) => {
								e.stopPropagation()
								toggleFavorite(item.id, isFavoritedItem)
							}}
							title={isFavoritedItem ? t("history.removeFavorite") : t("history.addFavorite")}
							variant="icon">
							<StarIcon
								className={cn("!size-3.5 opacity-70", {
									"text-button-background  fill-button-background opacity-100": isFavoritedItem,
								})}
							/>
						</Button>
					</div>
				</div>
				{openError && <div className="text-xs text-error">{openError}</div>}

				<Button
					className="p-0"
					onClick={(e) => {
						e.stopPropagation()
						setExpanded(!expanded)
					}}
					variant="icon">
					<div className="flex items-center justify-between w-full">
						<div className="text-description text-xs uppercase">{formatDate(item.ts)}</div>
						<div className="self-end flex items-center text-xs">
							{expanded ? (
								<ChevronsDownUpIcon className="text-description" />
							) : (
								<ChevronsUpDownIcon className="text-description hidden opacity-0 group-hover:opacity-100 transition-opacity group-hover:block" />
							)}
						</div>
					</div>
				</Button>
				{expanded && (
					<Button
						className="m-0 text-xs cursor-pointer p-2 bg-accent/10 w-full rounded-xs"
						onClick={(e) => {
							e.stopPropagation()
							setExpanded(!expanded)
						}}
						variant="text">
						<div className="flex flex-col gap-1 w-full text-xs">
							<div className="flex items-center justify-between w-full">
								<div className="flex items-center gap-1 flex-wrap w-full">
									<div className="flex justify-between items-center w-full gap-1 text-xs">
										<span className="font-medium text-description">{t("history.tokens")}</span>
										<div className="flex items-center gap-1 text-description text-xs">
											<span className="flex items-center gap-1 text-description">
												<ArrowUpIcon className="text-description !size-1" />
												{formatLargeNumber(item.tokensIn || 0)}
											</span>
											<span className="flex items-center gap-1 text-description">
												<ArrowDownIcon className="text-description !size-1" />
												{formatLargeNumber(item.tokensOut || 0)}
											</span>
											{item.cacheWrites
												? item.cacheWrites > 0 && (
														<span className="flex items-center gap-1 text-description">
															<ArrowRightIcon className="text-description !size-1" />
															{formatLargeNumber(item.cacheWrites)}
														</span>
													)
												: null}
											{item.cacheReads
												? item.cacheReads > 0 && (
														<span className="flex items-center gap-1 text-description">
															<ArrowLeftIcon className="text-description !size-1" />
															{formatLargeNumber(item.cacheReads)}
														</span>
													)
												: null}
										</div>
									</div>

									{item.modelId && (
										<div className="flex justify-between items-center w-full gap-1 text-xs">
											<span className="font-medium text-description">{t("history.model")}</span>
											<span className="min-w-0 break-all text-right text-description">{item.modelId}</span>
										</div>
									)}

									<div className="flex justify-between items-center w-full gap-1 text-xs">
										<span className="font-medium text-description">{t("history.size")}</span>
										<span className="items-center gap-2 flex text-description">
											{formatSize(item.size)}
											<Button
												aria-label={t("history.export")}
												className="m-0 p-0"
												onClick={(e) => {
													e.stopPropagation()
													TaskServiceClient.exportTaskWithId(
														StringRequest.create({ value: item.id }),
													).catch((err) => console.error("Failed to export task:", err))
												}}
												variant="ghost">
												<DownloadIcon />
											</Button>
										</span>
									</div>
								</div>
							</div>
						</div>
					</Button>
				)}
			</div>
		</div>
	)
}

export default memo(HistoryViewItem)
