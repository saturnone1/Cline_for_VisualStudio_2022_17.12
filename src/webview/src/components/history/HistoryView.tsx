import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react";
import { FunnelIcon } from "lucide-react";
import { memo, useMemo } from "react";
import { GroupedVirtuoso } from "react-virtuoso";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { useExtensionState } from "@/context/ExtensionStateContext";
import { useI18n } from "@/i18n";
import { formatSize } from "@/utils/format";
import ViewHeader from "../common/ViewHeader";
import HistoryViewItem from "./HistoryViewItem";
import { type HistorySortOption, useHistoryViewController } from "./useHistoryViewController";

type HistoryViewProps = {
	onDone: () => void;
};

const isToday = (timestamp: number): boolean => {
	const date = new Date(timestamp);
	const today = new Date();
	return today.toDateString() === date.toDateString();
};

const HistoryView = ({ onDone }: HistoryViewProps) => {
	const extensionStateContext = useExtensionState();
	const { taskHistory, onRelinquishControl, environment } = extensionStateContext;
	const { t } = useI18n();
	const {
		tasks, searchQuery, setSearchQuery, sortOption, setSortOption, lastNonRelevantSort, setLastNonRelevantSort,
		deleteAllDisabled, setDeleteAllDisabled, selectedItems, showFavoritesOnly, setShowFavoritesOnly,
		showCurrentWorkspaceOnly, setShowCurrentWorkspaceOnly, pendingFavoriteToggles, totalTasksSize,
		loadTaskHistory, fetchTotalTasksSize, toggleFavorite, handleHistorySelect, handleDeleteHistoryItem,
		handleDeleteSelectedHistoryItems, handleBatchHistorySelect, deleteAllTasks,
	} = useHistoryViewController();
	const taskHistorySearchResults = tasks;
	const handleTaskOpened = onDone;

	// Group tasks into "Today" and "Older" (only for date-based sorts)
	const { groupedTasks, groupCounts, groupLabels } = useMemo(() => {
		const isDateSort = sortOption === "newest" || sortOption === "oldest";

		if (!isDateSort) {
			// No grouping for non-date sorts
			return {
				groupedTasks: taskHistorySearchResults,
				groupCounts: [taskHistorySearchResults.length],
				groupLabels: [] as string[],
			};
		}

		const todayTasks: any[] = [];
		const olderTasks: any[] = [];

		taskHistorySearchResults.forEach((task) => {
			if (isToday(task.ts)) {
				todayTasks.push(task);
			} else {
				olderTasks.push(task);
			}
		});

		const groups: { tasks: any[]; label: string }[] = [];
		if (todayTasks.length > 0) {
			groups.push({ tasks: todayTasks, label: t("history.today") });
		}
		if (olderTasks.length > 0) {
			groups.push({ tasks: olderTasks, label: t("history.older") });
		}

		return {
			groupedTasks: groups.flatMap((g) => g.tasks),
			groupCounts: groups.map((g) => g.tasks.length),
			groupLabels: groups.map((g) => g.label),
		};
	}, [taskHistorySearchResults, sortOption, t]);

	// Calculate total size of selected items
	const selectedItemsSize = useMemo(() => {
		if (selectedItems.length === 0) {
			return 0;
		}

		return tasks.filter((item) => selectedItems.includes(item.id)).reduce((total, item) => total + (item.size || 0), 0);
	}, [selectedItems, tasks]);

	return (
		<div className="fixed overflow-hidden inset-0 flex min-w-0 flex-col w-full">
			{/* HEADER */}
			<ViewHeader environment={environment} onDone={onDone} title={t("history.title")} />

			{/* FILTERS */}
			<div className="flex shrink-0 flex-col gap-3 px-3">
				{/* REPLACE VSCODE RADIO GROUP */}
				<div className="flex min-w-0 items-center gap-2">
					{/* SEARCH BOX */}
					<VSCodeTextField
						className="min-w-0 flex-1"
						onInput={(e) => {
							const newValue = (e.target as HTMLInputElement)?.value;
							setSearchQuery(newValue);
							if (newValue && !searchQuery && sortOption !== "mostRelevant") {
								setLastNonRelevantSort(sortOption);
								setSortOption("mostRelevant");
							}
						}}
						placeholder={t("history.search")}
						value={searchQuery}
					>
						<div className="codicon codicon-search opacity-80 mt-0.5 !text-sm" slot="start" />
						{searchQuery && (
							<div
								aria-label={t("history.clearSearch")}
								className="input-icon-button codicon codicon-close flex justify-center items-center h-full"
								onClick={() => setSearchQuery("")}
								slot="end"
							/>
						)}
					</VSCodeTextField>
					<Select
						onValueChange={(value) => {
							// Handle sort options
							if (
								value === "newest" ||
								value === "oldest" ||
								value === "mostExpensive" ||
								value === "mostTokens" ||
								value === "mostRelevant"
							) {
								if (value === "mostRelevant" && !searchQuery) {
									// Don't allow selecting mostRelevant without a search query
									return;
								}
								setSortOption(value as HistorySortOption);
								if (value !== "mostRelevant") {
									setLastNonRelevantSort(value as HistorySortOption);
								}
							}
							// Handle filter toggles
							else if (value === "workspaceOnly") {
								setShowCurrentWorkspaceOnly(!showCurrentWorkspaceOnly);
							} else if (value === "favoritesOnly") {
								setShowFavoritesOnly(!showFavoritesOnly);
							}
						}}
						value={sortOption}
					>
						<SelectTrigger
							aria-label={t("history.filters")}
							className="relative size-7 shrink-0 cursor-pointer border border-editor-group-border p-0"
							showIcon={false}
							title={t("history.filters")}
						>
							<FunnelIcon className="!size-3.5 text-foreground" />
							{(showFavoritesOnly || showCurrentWorkspaceOnly) && (
								<span className="absolute -right-1 -top-1 flex size-3 items-center justify-center rounded-full bg-button-background text-[8px] text-primary-foreground">
									{Number(showFavoritesOnly) + Number(showCurrentWorkspaceOnly)}
								</span>
							)}
						</SelectTrigger>
						<SelectContent align="end" position="popper">
							{Object.entries({
								newest: t("history.newest"),
								oldest: t("history.oldest"),
								mostTokens: t("history.mostTokens"),
								mostRelevant: t("history.mostRelevant"),
								workspaceOnly: t("history.workspaceOnly"),
								favoritesOnly: t("history.favoritesOnly"),
							}).map(([key, value]) => {
								const isSortOption = ["newest", "oldest", "mostTokens", "mostRelevant"].includes(key);
								const isFilterOption = ["workspaceOnly", "favoritesOnly"].includes(key);
								const isSelected = isSortOption
									? sortOption === key
									: key === "workspaceOnly"
										? showCurrentWorkspaceOnly
										: key === "favoritesOnly"
											? showFavoritesOnly
											: false;
								const isDisabled = key === "mostRelevant" && !searchQuery;

								return (
									<SelectItem
										className={isSelected ? "bg-button-background/30" : ""}
										disabled={isDisabled}
										key={key}
										value={key}
									>
										<span className="flex items-center gap-2">
											{isFilterOption && (
												<span
													className={`codicon ${
														key === "workspaceOnly" ? "codicon-folder" : "codicon-star-full"
													} ${isSelected ? "text-button-background" : ""}`}
												/>
											)}
											{value}
										</span>
									</SelectItem>
								);
							})}
						</SelectContent>
					</Select>
				</div>
			</div>

			{/* HISTORY ITEMS */}
			<div className="m-0 min-h-0 w-full flex-1 overflow-y-auto py-2">
				<GroupedVirtuoso
					className="flex-grow overflow-y-scroll"
					groupContent={(index) => (
						<div className="px-4 py-2 text-xs font-bold uppercase tracking-wide sticky top-0 z-10 text-description bg-sidebar-background border-b-border-panel">
							{groupLabels[index]}
						</div>
					)}
					groupCounts={groupCounts}
					endReached={() => { void loadTaskHistory(false); }}
					itemContent={(index) => {
						const item = groupedTasks[index];
						return (
							<HistoryViewItem
								handleDeleteHistoryItem={handleDeleteHistoryItem}
								handleHistorySelect={handleHistorySelect}
								handleTaskOpened={handleTaskOpened}
								index={index}
								item={item}
								pendingFavoriteToggles={pendingFavoriteToggles}
								selectedItems={selectedItems}
								toggleFavorite={toggleFavorite}
							/>
						);
					}}
				/>
			</div>

			{/* FOOTER */}
			<div className="shrink-0 border-t border-t-border-panel p-2.5">
				<div className="mb-2.5 grid grid-cols-2 gap-2">
					<Button
						className="min-w-0 whitespace-normal px-2"
						onClick={() => handleBatchHistorySelect(true)}
						variant="secondary"
					>
						{t("history.selectAll")}
					</Button>
					<Button
						className="min-w-0 whitespace-normal px-2"
						onClick={() => handleBatchHistorySelect(false)}
						variant="secondary"
					>
						{t("history.selectNone")}
					</Button>
				</div>
				{selectedItems.length > 0 ? (
					<Button
						aria-label={t("history.deleteSelectedAria")}
						className="min-h-8 w-full whitespace-normal px-2 leading-tight"
						onClick={() => {
							handleDeleteSelectedHistoryItems(selectedItems);
						}}
						variant="danger"
					>
						{t("history.deleteSelected", { count: selectedItems.length })}
						{selectedItemsSize > 0 ? ` (${formatSize(selectedItemsSize)})` : ""}
					</Button>
				) : (
					<Button
						aria-label={t("history.deleteAllAria")}
						className="min-h-8 w-full whitespace-normal px-2 leading-tight"
						disabled={deleteAllDisabled || taskHistory.length === 0}
						onClick={async () => {
							await deleteAllTasks();
						}}
						variant="danger"
					>
						{t("history.deleteAll")}
						{totalTasksSize !== null ? ` (${formatSize(totalTasksSize)})` : ""}
					</Button>
				)}
			</div>
		</div>
	);
};

// https://gist.github.com/evenfrost/1ba123656ded32fb7a0cd4651efd4db0
export default memo(HistoryView);
