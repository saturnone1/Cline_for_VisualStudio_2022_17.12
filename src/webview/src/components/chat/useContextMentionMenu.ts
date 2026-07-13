import { StringRequest } from "@shared/proto/cline/common"
import type React from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { FileServiceClient } from "@/services/grpcClient"
import {
	ContextMenuOptionType,
	getContextMenuOptionIndex,
	getContextMenuOptions,
	insertMention,
	shouldShowContextMenu,
} from "@/utils/contextMentions"
import { useMentionSearch } from "./useMentionSearch"

const DEFAULT_CONTEXT_MENU_OPTION = getContextMenuOptionIndex(ContextMenuOptionType.File)

interface GitCommit {
	type: ContextMenuOptionType.Git
	value: string
	label: string
	description: string
}

interface UseContextMentionMenuOptions {
	cursorPosition: number
	setCursorPosition: React.Dispatch<React.SetStateAction<number>>
	setInputValue: (value: string) => void
	setIntendedCursorPosition: React.Dispatch<React.SetStateAction<number | null>>
	textAreaRef: React.RefObject<HTMLTextAreaElement | null>
}

export function useContextMentionMenu({
	cursorPosition,
	setCursorPosition,
	setInputValue,
	setIntendedCursorPosition,
	textAreaRef,
}: UseContextMentionMenuOptions) {
	const [showContextMenu, setShowContextMenu] = useState(false)
	const [searchQuery, setSearchQuery] = useState("")
	const [selectedMenuIndex, setSelectedMenuIndex] = useState(-1)
	const [selectedType, setSelectedType] = useState<ContextMenuOptionType | null>(null)
	const [gitCommits, setGitCommits] = useState<GitCommit[]>([])
	const contextMenuContainerRef = useRef<HTMLDivElement>(null)
	const { fileSearchResults, searchLoading, runMentionSearch, scheduleMentionSearch, clearMentionSearch } =
		useMentionSearch()

	useEffect(() => {
		if (selectedType !== ContextMenuOptionType.Git && !/^[a-f0-9]+$/i.test(searchQuery)) {
			return
		}

		FileServiceClient.searchCommits(StringRequest.create({ value: searchQuery || "" }))
			.then((response) => {
				if (!response.commits) {
					return
				}
				setGitCommits(
					response.commits.map(
						(commit: { hash: string; shortHash: string; subject: string; author: string; date: string }) => ({
							type: ContextMenuOptionType.Git,
							value: commit.hash,
							label: commit.subject,
							description: `${commit.shortHash} by ${commit.author} on ${commit.date}`,
						}),
					),
				)
			})
			.catch((error) => console.error("Error searching commits:", error))
	}, [selectedType, searchQuery])

	const queryItems = useMemo(
		() => [
			{ type: ContextMenuOptionType.Problems, value: "problems" },
			{ type: ContextMenuOptionType.Terminal, value: "terminal" },
			...gitCommits,
		],
		[gitCommits],
	)

	useEffect(() => {
		if (!showContextMenu) {
			return
		}
		const handleClickOutside = (event: MouseEvent) => {
			if (contextMenuContainerRef.current && !contextMenuContainerRef.current.contains(event.target as Node)) {
				setShowContextMenu(false)
			}
		}
		document.addEventListener("mousedown", handleClickOutside)
		return () => document.removeEventListener("mousedown", handleClickOutside)
	}, [showContextMenu])

	useEffect(() => {
		if (!showContextMenu) {
			setSelectedType(null)
			clearMentionSearch()
		}
	}, [showContextMenu, clearMentionSearch])

	const handleMentionSelect = useCallback(
		(type: ContextMenuOptionType, value?: string) => {
			if (type === ContextMenuOptionType.NoResults) {
				return
			}
			if (
				(type === ContextMenuOptionType.File ||
					type === ContextMenuOptionType.Folder ||
					type === ContextMenuOptionType.Git) &&
				!value
			) {
				setSelectedType(type)
				setSearchQuery("")
				setSelectedMenuIndex(0)
				if (type === ContextMenuOptionType.File || type === ContextMenuOptionType.Folder) {
					void runMentionSearch("", type)
				}
				return
			}

			setShowContextMenu(false)
			setSelectedType(null)
			const queryLength = searchQuery.length
			setSearchQuery("")
			if (!textAreaRef.current) {
				return
			}

			const insertValue =
				type === ContextMenuOptionType.Problems
					? "problems"
					: type === ContextMenuOptionType.Terminal
						? "terminal"
						: value || ""
			const { newValue, mentionIndex } = insertMention(
				textAreaRef.current.value,
				cursorPosition,
				insertValue,
				queryLength,
			)
			setInputValue(newValue)
			const nextCursorPosition = newValue.indexOf(" ", mentionIndex + insertValue.length) + 1
			setCursorPosition(nextCursorPosition)
			setIntendedCursorPosition(nextCursorPosition)
			setTimeout(() => {
				textAreaRef.current?.blur()
				textAreaRef.current?.focus()
			}, 0)
		},
		[
			cursorPosition,
			runMentionSearch,
			searchQuery,
			setCursorPosition,
			setInputValue,
			setIntendedCursorPosition,
			textAreaRef,
		],
	)

	const updateMentionMenu = useCallback(
		(value: string, nextCursorPosition: number, slashMenuVisible: boolean) => {
			const shouldShow = !slashMenuVisible && shouldShowContextMenu(value, nextCursorPosition)
			setShowContextMenu(shouldShow)
			if (!shouldShow) {
				setSearchQuery("")
				setSelectedMenuIndex(-1)
				clearMentionSearch()
				return
			}

			const lastAtIndex = value.lastIndexOf("@", nextCursorPosition - 1)
			const query = value.slice(lastAtIndex + 1, nextCursorPosition)
			setSearchQuery(query)
			if (query.length > 0) {
				setSelectedMenuIndex(0)
				scheduleMentionSearch(query, selectedType)
			} else {
				setSelectedMenuIndex(DEFAULT_CONTEXT_MENU_OPTION)
				clearMentionSearch()
			}
		},
		[clearMentionSearch, scheduleMentionSearch, selectedType],
	)

	const handleMentionMenuKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLTextAreaElement>) => {
			if (!showContextMenu) {
				return false
			}
			if (event.key === "Escape") {
				setShowContextMenu(false)
				setSelectedType(null)
				setSelectedMenuIndex(DEFAULT_CONTEXT_MENU_OPTION)
				setSearchQuery("")
				return true
			}
			if (event.key === "ArrowUp" || event.key === "ArrowDown") {
				event.preventDefault()
				const options = getContextMenuOptions(searchQuery, selectedType, queryItems, fileSearchResults)
				const selectableOptions = options.filter(
					(option) => option.type !== ContextMenuOptionType.URL && option.type !== ContextMenuOptionType.NoResults,
				)
				setSelectedMenuIndex((previousIndex) => {
					if (options.length === 0 || selectableOptions.length === 0) {
						return selectableOptions.length === 0 ? -1 : previousIndex
					}
					const direction = event.key === "ArrowUp" ? -1 : 1
					const currentSelectableIndex = selectableOptions.indexOf(options[previousIndex])
					const nextSelectableIndex =
						(currentSelectableIndex + direction + selectableOptions.length) % selectableOptions.length
					return options.indexOf(selectableOptions[nextSelectableIndex])
				})
				return true
			}
			if ((event.key === "Enter" || event.key === "Tab") && selectedMenuIndex !== -1) {
				event.preventDefault()
				const selectedOption = getContextMenuOptions(searchQuery, selectedType, queryItems, fileSearchResults)[
					selectedMenuIndex
				]
				if (
					selectedOption &&
					selectedOption.type !== ContextMenuOptionType.URL &&
					selectedOption.type !== ContextMenuOptionType.NoResults
				) {
					const mentionValue = selectedOption.label?.includes(":") ? selectedOption.label : selectedOption.value
					handleMentionSelect(selectedOption.type, mentionValue)
				}
				return true
			}
			return false
		},
		[
			fileSearchResults,
			handleMentionSelect,
			queryItems,
			searchQuery,
			selectedMenuIndex,
			selectedType,
			showContextMenu,
		],
	)

	const openMentionMenu = useCallback(() => {
		setSelectedType(null)
		setShowContextMenu(true)
	}, [])
	const closeMentionMenu = useCallback(() => setShowContextMenu(false), [])

	return {
		closeMentionMenu,
		contextMenuContainerRef,
		fileSearchResults,
		handleMentionMenuKeyDown,
		handleMentionSelect,
		openMentionMenu,
		queryItems,
		searchLoading,
		searchQuery,
		selectedMenuIndex,
		selectedType,
		setSelectedMenuIndex,
		setShowContextMenu,
		showContextMenu,
		updateMentionMenu,
	}
}
