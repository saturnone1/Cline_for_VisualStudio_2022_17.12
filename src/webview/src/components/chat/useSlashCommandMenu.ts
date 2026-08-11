import type { SlashCommand } from "@shared/slashCommands"
import { type KeyboardEvent, type RefObject, useCallback, useEffect, useState } from "react"
import { getMatchingSlashCommands, insertSlashCommand, shouldShowSlashCommandsMenu } from "@/utils/slashCommands"

type MatchingArguments = Parameters<typeof getMatchingSlashCommands>

export function slashQueryAtCursor(value: string, cursorPosition: number): string {
	const beforeCursor = value.slice(0, cursorPosition)
	return value.slice(beforeCursor.lastIndexOf("/") + 1, cursorPosition)
}

export function nextMenuIndex(current: number, direction: -1 | 1, itemCount: number): number {
	return itemCount === 0 ? current : (current + direction + itemCount) % itemCount
}

interface UseSlashCommandMenuOptions {
	inputValue: string
	cursorPosition: number
	setInputValue: (value: string) => void
	setCursorPosition: (value: number) => void
	setIntendedCursorPosition: (value: number | null) => void
	textAreaRef: RefObject<HTMLTextAreaElement | null>
	menuContainerRef: RefObject<HTMLDivElement | null>
	localWorkflowToggles: MatchingArguments[1]
	globalWorkflowToggles: MatchingArguments[2]
	remoteWorkflowToggles: MatchingArguments[3]
	remoteGlobalWorkflows: MatchingArguments[4]
	mcpServers: MatchingArguments[5]
}

export function useSlashCommandMenu(options: UseSlashCommandMenuOptions) {
	const [showSlashCommandsMenu, setShowSlashCommandsMenu] = useState(false)
	const [selectedSlashCommandsIndex, setSelectedSlashCommandsIndex] = useState(0)
	const [slashCommandsQuery, setSlashCommandsQuery] = useState("")

	const matchingCommands = useCallback(
		() =>
			getMatchingSlashCommands(
				slashCommandsQuery,
				options.localWorkflowToggles,
				options.globalWorkflowToggles,
				options.remoteWorkflowToggles,
				options.remoteGlobalWorkflows,
				options.mcpServers,
			),
		[slashCommandsQuery, options],
	)

	const closeSlashCommandsMenu = useCallback(() => {
		setShowSlashCommandsMenu(false)
		setSlashCommandsQuery("")
	}, [])

	useEffect(() => {
		if (!showSlashCommandsMenu) {
			return
		}
		const handleClickOutside = (event: MouseEvent) => {
			if (options.menuContainerRef.current && !options.menuContainerRef.current.contains(event.target as Node)) {
				closeSlashCommandsMenu()
			}
		}
		document.addEventListener("mousedown", handleClickOutside)
		return () => document.removeEventListener("mousedown", handleClickOutside)
	}, [showSlashCommandsMenu, options.menuContainerRef, closeSlashCommandsMenu])

	const handleSlashCommandsSelect = useCallback(
		(command: SlashCommand) => {
			closeSlashCommandsMenu()
			if (!options.textAreaRef.current) {
				return
			}
			const { newValue, commandIndex } = insertSlashCommand(
				options.textAreaRef.current.value,
				command.name,
				slashCommandsQuery.length,
				options.cursorPosition,
			)
			const cursorPosition = newValue.indexOf(" ", commandIndex + 1 + command.name.length) + 1
			options.setInputValue(newValue)
			options.setCursorPosition(cursorPosition)
			options.setIntendedCursorPosition(cursorPosition)
			setTimeout(() => {
				options.textAreaRef.current?.blur()
				options.textAreaRef.current?.focus()
			}, 0)
		},
		[closeSlashCommandsMenu, options, slashCommandsQuery.length],
	)

	const updateSlashCommandsMenu = useCallback((value: string, cursorPosition: number) => {
		const show = shouldShowSlashCommandsMenu(value, cursorPosition)
		setShowSlashCommandsMenu(show)
		setSlashCommandsQuery(show ? slashQueryAtCursor(value, cursorPosition) : "")
		setSelectedSlashCommandsIndex(0)
		return show
	}, [])

	const handleSlashMenuKeyDown = useCallback(
		(event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
			if (!showSlashCommandsMenu) {
				return false
			}
			if (event.key === "Escape") {
				closeSlashCommandsMenu()
				return true
			}
			if (event.key === "ArrowUp" || event.key === "ArrowDown") {
				event.preventDefault()
				const commands = matchingCommands()
				setSelectedSlashCommandsIndex((current) =>
					nextMenuIndex(current, event.key === "ArrowUp" ? -1 : 1, commands.length),
				)
				return true
			}
			if ((event.key === "Enter" || event.key === "Tab") && selectedSlashCommandsIndex !== -1) {
				event.preventDefault()
				const command = matchingCommands()[selectedSlashCommandsIndex]
				if (command) {
					handleSlashCommandsSelect(command)
				}
				return true
			}
			return false
		},
		[
			showSlashCommandsMenu,
			selectedSlashCommandsIndex,
			closeSlashCommandsMenu,
			matchingCommands,
			handleSlashCommandsSelect,
		],
	)

	return {
		showSlashCommandsMenu,
		selectedSlashCommandsIndex,
		setSelectedSlashCommandsIndex,
		slashCommandsQuery,
		handleSlashCommandsSelect,
		handleSlashMenuKeyDown,
		updateSlashCommandsMenu,
		closeSlashCommandsMenu,
	}
}
