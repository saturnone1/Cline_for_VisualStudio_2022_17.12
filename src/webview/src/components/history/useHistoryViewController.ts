import type { HistoryItem } from "@shared/HistoryItem"
import { BooleanRequest, EmptyRequest, StringArrayRequest } from "@shared/proto/cline/common"
import { GetTaskHistoryRequest, TaskFavoriteRequest } from "@shared/proto/cline/task"
import { useCallback, useDeferredValue, useEffect, useRef, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { TaskServiceClient } from "@/services/grpcClient"

export type HistorySortOption = "newest" | "oldest" | "mostTokens" | "mostRelevant"

export function useHistoryViewController() {
	const { onRelinquishControl, totalTasksSize, setTotalTasksSize } = useExtensionState()
	const [searchQuery, setSearchQuery] = useState("")
	const deferredSearchQuery = useDeferredValue(searchQuery)
	const [sortOption, setSortOption] = useState<HistorySortOption>("newest")
	const [lastNonRelevantSort, setLastNonRelevantSort] = useState<HistorySortOption | null>("newest")
	const [deleteAllDisabled, setDeleteAllDisabled] = useState(false)
	const [selectedItems, setSelectedItems] = useState<string[]>([])
	const [showFavoritesOnly, setShowFavoritesOnly] = useState(false)
	const [showCurrentWorkspaceOnly, setShowCurrentWorkspaceOnly] = useState(false)
	const [pendingFavoriteToggles, setPendingFavoriteToggles] = useState<Record<string, boolean>>({})
	const [tasks, setTasks] = useState<HistoryItem[]>([])
	const historyRequestSequence = useRef(0)
	const nextCursorRef = useRef(0)
	const paginationLoadingRef = useRef(false)
	const resetRequestsInFlightRef = useRef(0)

	const loadTaskHistory = useCallback(async (reset = true) => {
		if (!reset && (paginationLoadingRef.current || resetRequestsInFlightRef.current > 0 || nextCursorRef.current < 0)) return
		if (reset) resetRequestsInFlightRef.current += 1
		else paginationLoadingRef.current = true
		const requestSequence = ++historyRequestSequence.current
		const cursor = reset ? 0 : nextCursorRef.current
		try {
			const response = await TaskServiceClient.getTaskHistory(GetTaskHistoryRequest.create({
				favoritesOnly: showFavoritesOnly,
				searchQuery: deferredSearchQuery,
				sortBy: sortOption,
				currentWorkspaceOnly: showCurrentWorkspaceOnly,
				cursor,
				pageSize: 100,
			}))
			if (requestSequence !== historyRequestSequence.current) return
			nextCursorRef.current = typeof response.nextCursor === "number" ? response.nextCursor : -1
			setTasks((previous) => reset ? response.tasks || [] : mergeTaskPages(previous, response.tasks || []))
		} catch (error) {
			if (requestSequence === historyRequestSequence.current) console.error("Error loading task history:", error)
		} finally {
			if (reset) resetRequestsInFlightRef.current = Math.max(0, resetRequestsInFlightRef.current - 1)
			else paginationLoadingRef.current = false
		}
	}, [deferredSearchQuery, showFavoritesOnly, showCurrentWorkspaceOnly, sortOption])

	useEffect(() => { nextCursorRef.current = 0; void loadTaskHistory(true) }, [loadTaskHistory])
	useEffect(() => onRelinquishControl(() => setDeleteAllDisabled(false)), [onRelinquishControl])

	const fetchTotalTasksSize = useCallback(async () => {
		try {
			const response = await TaskServiceClient.getTotalTasksSize(EmptyRequest.create({}))
			if (typeof response?.value === "number") setTotalTasksSize?.(response.value || 0)
		} catch (error) {
			console.error("Error getting total tasks size:", error)
		}
	}, [setTotalTasksSize])
	useEffect(() => { void fetchTotalTasksSize() }, [fetchTotalTasksSize])

	useEffect(() => {
		if (searchQuery && sortOption !== "mostRelevant" && !lastNonRelevantSort) {
			setLastNonRelevantSort(sortOption); setSortOption("mostRelevant")
		} else if (!searchQuery && sortOption === "mostRelevant" && lastNonRelevantSort) {
			setSortOption(lastNonRelevantSort); setLastNonRelevantSort(null)
		}
	}, [searchQuery, sortOption, lastNonRelevantSort])

	const toggleFavorite = useCallback(async (taskId: string, currentValue: boolean) => {
		setPendingFavoriteToggles((previous) => ({ ...previous, [taskId]: !currentValue }))
		try {
			await TaskServiceClient.toggleTaskFavorite(TaskFavoriteRequest.create({ taskId, isFavorited: !currentValue }))
			await loadTaskHistory()
		} catch (error) {
			console.error(`[FAVORITE_TOGGLE_UI] Error for task ${taskId}:`, error)
		} finally {
			setPendingFavoriteToggles((previous) => { const next = { ...previous }; delete next[taskId]; return next })
		}
	}, [loadTaskHistory])

	const handleHistorySelect = useCallback((itemId: string, checked: boolean) => {
		setSelectedItems((previous) => checked ? [...new Set([...previous, itemId])] : previous.filter((id) => id !== itemId))
	}, [])

	const handleDeleteHistoryItem = useCallback(async (id: string) => {
		setTasks((previous) => previous.filter((task) => task.id !== id))
		setSelectedItems((previous) => previous.filter((selectedId) => selectedId !== id))
		try {
			await TaskServiceClient.deleteTasksWithIds(StringArrayRequest.create({ value: [id] }))
			await Promise.all([fetchTotalTasksSize(), loadTaskHistory()])
		} catch (error) {
			console.error("Error deleting task:", error); await loadTaskHistory()
		}
	}, [fetchTotalTasksSize, loadTaskHistory])

	const handleDeleteSelectedHistoryItems = useCallback(async (ids: string[]) => {
		if (ids.length === 0) return
		const idSet = new Set(ids)
		setTasks((previous) => previous.filter((task) => !idSet.has(task.id)))
		setSelectedItems([])
		try {
			await TaskServiceClient.deleteTasksWithIds(StringArrayRequest.create({ value: ids }))
			await Promise.all([fetchTotalTasksSize(), loadTaskHistory()])
		} catch (error) {
			console.error("Error deleting tasks:", error); await loadTaskHistory()
		}
	}, [fetchTotalTasksSize, loadTaskHistory])

	const handleBatchHistorySelect = useCallback((selectAll: boolean) => {
		setSelectedItems(selectAll ? tasks.map((item) => item.id) : [])
	}, [tasks])

	const deleteAllTasks = useCallback(async () => {
		setDeleteAllDisabled(true)
		setTasks([])
		setSelectedItems([])
		try {
			await TaskServiceClient.deleteAllTaskHistory(BooleanRequest.create({}))
			await Promise.all([fetchTotalTasksSize(), loadTaskHistory()])
		} catch (error) {
			console.error("Error deleting task history:", error)
			await loadTaskHistory()
		} finally {
			setDeleteAllDisabled(false)
		}
	}, [fetchTotalTasksSize, loadTaskHistory])

	return {
		tasks, searchQuery, setSearchQuery, sortOption, setSortOption, lastNonRelevantSort, setLastNonRelevantSort,
		deleteAllDisabled, setDeleteAllDisabled, selectedItems, showFavoritesOnly, setShowFavoritesOnly,
		showCurrentWorkspaceOnly, setShowCurrentWorkspaceOnly, pendingFavoriteToggles, totalTasksSize,
		loadTaskHistory, fetchTotalTasksSize, toggleFavorite, handleHistorySelect, handleDeleteHistoryItem,
		handleDeleteSelectedHistoryItems, handleBatchHistorySelect, deleteAllTasks,
	}
}

function mergeTaskPages(previous: HistoryItem[], incoming: HistoryItem[]) {
	const byId = new Map(previous.map((task) => [task.id, task]))
	for (const task of incoming) byId.set(task.id, task)
	return [...byId.values()]
}
