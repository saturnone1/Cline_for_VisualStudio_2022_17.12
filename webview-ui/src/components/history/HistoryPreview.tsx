import { StringRequest } from "@shared/proto/cline/common"
import { memo, useMemo } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useI18n } from "@/i18n"
import { TaskServiceClient } from "@/services/grpc-client"

type HistoryPreviewProps = {
	showHistoryView: () => void
}

const HistoryPreview = ({ showHistoryView }: HistoryPreviewProps) => {
	const { didHydrateState, taskHistory } = useExtensionState()
	const { language, t } = useI18n()

	const visibleTasks = useMemo(() => {
		const source = taskHistory
		const map = new Map<string, (typeof taskHistory)[number]>()
		for (const item of source) {
			if (item.id && item.ts && item.task && !map.has(item.id)) {
				map.set(item.id, item)
			}
		}
		return Array.from(map.values())
			.sort((a, b) => (b.ts || 0) - (a.ts || 0))
			.slice(0, 3)
	}, [taskHistory])

	const handleHistorySelect = (id: string) => {
		TaskServiceClient.showTaskWithId(StringRequest.create({ value: id })).catch((error) =>
			console.error("Error showing task:", error),
		)
	}

	const formatDate = (timestamp: number) => {
		const date = new Date(timestamp)
		return date?.toLocaleString(language === "ko" ? "ko-KR" : "en-US", {
			month: "short",
			day: "numeric",
		})
	}

	return (
		<div style={{ flexShrink: 0 }}>
			<style>
				{`
					.history-preview-item {
						background-color: color-mix(in srgb, var(--vscode-toolbar-hoverBackground) 65%, transparent);
						border-radius: 4px;
						position: relative;
						overflow: hidden;
						cursor: pointer;
						margin-bottom: 8px;
						padding: 10px 12px;
						display: flex;
						align-items: flex-start;
						gap: 12px;
					}
					.history-preview-item:hover {
						background-color: color-mix(in srgb, var(--vscode-toolbar-hoverBackground) 100%, transparent);
						pointer-events: auto;
					}
					.history-task-content {
						flex: 1;
						display: flex;
						align-items: flex-start;
						gap: 8px;
						min-width: 0;
					}
					.history-task-description {
						flex: 1;
						overflow: hidden;
						display: -webkit-box;
						-webkit-line-clamp: 2;
						-webkit-box-orient: vertical;
						color: var(--vscode-foreground);
						font-size: var(--vscode-font-size);
						line-height: 1.4;
					}
					.history-meta-stack {
						display: flex;
						flex-direction: column;
						align-items: center;
						gap: 4px;
						flex-shrink: 0;
					}
					.history-date {
						color: var(--vscode-descriptionForeground);
						font-size: 0.85em;
						white-space: nowrap;
					}
					.history-view-all-btn {
						background: none;
						border: none;
						padding: 4px 0 4px 8px;
						cursor: pointer;
						font-size: 0.85em;
						font-weight: 500;
						color: var(--vscode-descriptionForeground);
						white-space: nowrap;
						display: flex;
						align-items: center;
						gap: 2px;
					}
					.history-view-all-btn .codicon {
						font-size: 1.2em;
					}
					.history-view-all-btn:hover {
						color: var(--vscode-foreground);
					}
				`}
			</style>

			<div
				className="history-header"
				style={{
					color: "var(--vscode-descriptionForeground)",
					margin: "10px 16px 10px 16px",
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
				}}>
				<div style={{ display: "flex", alignItems: "center" }}>
					<span
						className="codicon codicon-comment-discussion"
						style={{
							marginRight: "4px",
							transform: "scale(0.9)",
						}}></span>
					<span
						style={{
							fontWeight: 500,
							fontSize: "0.85em",
							textTransform: "uppercase",
						}}>
						{language === "ko" ? "최근 작업" : "Recent"}
					</span>
				</div>
				{visibleTasks.length > 0 && (
					<button
						aria-label={t("home.viewAll")}
						className="history-view-all-btn"
						onClick={() => showHistoryView()}
						type="button">
						{t("home.viewAll")}
						<span className="codicon codicon-chevron-right" />
					</button>
				)}
			</div>

			{
				<div className="px-4">
					{visibleTasks.length > 0 ? (
						visibleTasks.map((item) => (
							<div className="history-preview-item" key={item.id} onClick={() => handleHistorySelect(item.id)}>
								<div className="history-task-content">
									{item.isFavorited && (
										<span
											aria-label={t("history.favoritesOnly")}
											className="codicon codicon-star-full"
											style={{
												color: "var(--vscode-button-background)",
												flexShrink: 0,
											}}
										/>
									)}
									<div className="history-task-description ph-no-capture">{item.task}</div>
								</div>
								<div className="history-meta-stack">
									<span className="history-date">{formatDate(item.ts)}</span>
								</div>
							</div>
						))
					) : didHydrateState ? (
						<div
							style={{
								textAlign: "center",
								color: "var(--vscode-descriptionForeground)",
								fontSize: "var(--vscode-font-size)",
								padding: "10px 0",
							}}>
							{language === "ko" ? "최근 작업이 없습니다" : "No recent tasks"}
						</div>
					) : (
						<div
							style={{
								textAlign: "center",
								color: "var(--vscode-descriptionForeground)",
								fontSize: "var(--vscode-font-size)",
								padding: "10px 0",
							}}>
							{language === "ko" ? "최근 작업 불러오는 중..." : "Loading recent tasks..."}
						</div>
					)}
				</div>
			}
		</div>
	)
}

export default memo(HistoryPreview)
