import { mentionRegex, mentionRegexGlobal } from "@shared/contextMentions"
import { StringRequest } from "@shared/proto/cline/common"
import { FileSearchRequest, FileSearchType } from "@shared/proto/cline/file"
import { PlanActMode, TogglePlanActModeRequest } from "@shared/proto/cline/state"
import { Mode } from "@shared/storage/types"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { AtSignIcon, PlusIcon, Settings } from "lucide-react"
import type React from "react"
import { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import DynamicTextArea from "react-textarea-autosize"
import styled from "styled-components"
import ContextMenu from "@/components/chat/ContextMenu"
import SlashCommandMenu from "@/components/chat/SlashCommandMenu"
import Thumbnails from "@/components/common/Thumbnails"
import { getModeSpecificFields, normalizeApiConfiguration } from "@/components/settings/utils/providerUtils"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { usePlatform } from "@/context/PlatformContext"
import { useI18n } from "@/i18n"
import { cn } from "@/lib/utils"
import { FileServiceClient, StateServiceClient } from "@/services/grpcClient"
import {
	ContextMenuOptionType,
	getContextMenuOptionIndex,
	getContextMenuOptions,
	insertMention,
	insertMentionDirectly,
	removeMention,
	type SearchResult,
	shouldShowContextMenu,
} from "@/utils/contextMentions"
import { useMetaKeyDetection, useShortcut } from "@/utils/hooks"
import { isSafari } from "@/utils/platformUtils"
import { removeSlashCommand, slashCommandDeleteRegex, slashCommandRegexGlobal, validateSlashCommand } from "@/utils/slashCommands"
import ClineRulesToggleModal from "../clineRules/ClineRulesToggleModal"
import ServersToggleModal from "./ServersToggleModal"
import { useChatDrop } from "./useChatDrop"
import { useChatPaste } from "./useChatPaste"
import { useSlashCommandMenu } from "./useSlashCommandMenu"

// Set to "File" option by default
const DEFAULT_CONTEXT_MENU_OPTION = getContextMenuOptionIndex(ContextMenuOptionType.File)

interface ChatTextAreaProps {
	inputValue: string
	activeQuote: string | null
	setInputValue: (value: string) => void
	sendingDisabled: boolean
	placeholderText: string
	selectedFiles: string[]
	selectedImages: string[]
	setSelectedImages: React.Dispatch<React.SetStateAction<string[]>>
	setSelectedFiles: React.Dispatch<React.SetStateAction<string[]>>
	onSend: () => void
	onCancelRequest?: () => void
	onSelectFilesAndImages: () => void
	requestPending?: boolean
	shouldDisableFilesAndImages: boolean
	onHeightChange?: (height: number) => void
	onFocusChange?: (isFocused: boolean) => void
}

interface GitCommit {
	type: ContextMenuOptionType.Git
	value: string
	label: string
	description: string
}

const SwitchContainer = styled.div<{ disabled: boolean }>`
	display: flex;
	align-items: center;
	background-color: transparent;
	border: 1px solid var(--vscode-input-border);
	border-radius: 12px;
	overflow: hidden;
	cursor: ${(props) => (props.disabled ? "not-allowed" : "pointer")};
	opacity: ${(props) => (props.disabled ? 0.5 : 1)};
	transform: scale(1);
	transform-origin: right center;
	margin-left: 0;
	user-select: none; // Prevent text selection
	box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--vscode-focusBorder) 18%, transparent);
`

const Slider = styled.div.withConfig({
	shouldForwardProp: (prop) => prop !== "isAct",
})<{ isAct: boolean }>`
	position: absolute;
	height: 100%;
	width: 50%;
	background-color: var(--lig-mode-active-background);
	box-shadow: 0 0 0 1px color-mix(in srgb, var(--vscode-editor-foreground) 18%, transparent);
	transition: transform 0.2s ease;
	transform: translateX(${(props) => (props.isAct ? "100%" : "0%")});
`

const ButtonGroup = styled.div`
	display: flex;
	align-items: center;
	gap: 4px;
	flex: 1;
	min-width: 0;
`

const ButtonContainer = styled.div`
	display: flex;
	align-items: center;
	gap: 3px;
	font-size: 10px;
	white-space: nowrap;
	min-width: 0;
	width: 100%;
`

const ModelContainer = styled.div`
	position: relative;
	display: flex;
	flex: 1;
	min-width: 0;
`

const ModelTextWrapper = styled.div`
	display: inline-flex; // Make it shrink to content
	min-width: 0; // Allow shrinking
	max-width: 100%; // Don't overflow parent
`

const ModelDisplayText = styled.span`
	padding: 0px 0px;
	height: 20px;
	width: 100%;
	min-width: 0;
	color: var(--vscode-descriptionForeground);
	display: flex;
	align-items: center;
	font-size: 10px;
	user-select: none;
`

const ModelButtonContent = styled.div`
	width: 100%;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
`

const ChatTextArea = forwardRef<HTMLTextAreaElement, ChatTextAreaProps>(
	(
		{
			inputValue,
			setInputValue,
			sendingDisabled,
			placeholderText,
			selectedFiles,
			selectedImages,
			setSelectedImages,
			setSelectedFiles,
			onSend,
			onCancelRequest,
			onSelectFilesAndImages,
			requestPending = false,
			shouldDisableFilesAndImages,
			onHeightChange,
			onFocusChange,
		},
		ref,
	) => {
		const {
			mode,
			apiConfiguration,
			openRouterModels,
			platform,
			localWorkflowToggles,
			globalWorkflowToggles,
			remoteWorkflowToggles,
			remoteConfigSettings,
			navigateToSettings,
			mcpServers,
		} = useExtensionState()
		const { t } = useI18n()
		const { selectedModelInfo } = useMemo(() => normalizeApiConfiguration(apiConfiguration, mode), [apiConfiguration, mode])
		const modelSupportsImages = selectedModelInfo.supportsImages || false
		const [isTextAreaFocused, setIsTextAreaFocused] = useState(false)
		const [gitCommits, setGitCommits] = useState<GitCommit[]>([])
		const slashCommandsMenuContainerRef = useRef<HTMLDivElement>(null)

		const [thumbnailsHeight, setThumbnailsHeight] = useState(0)
		const [textAreaBaseHeight, setTextAreaBaseHeight] = useState<number | undefined>(undefined)
		const [showContextMenu, setShowContextMenu] = useState(false)
		const [cursorPosition, setCursorPosition] = useState(0)
		const [searchQuery, setSearchQuery] = useState("")
		const textAreaRef = useRef<HTMLTextAreaElement | null>(null)
		const [isMouseDownOnMenu, setIsMouseDownOnMenu] = useState(false)
		const highlightLayerRef = useRef<HTMLDivElement>(null)
		const [selectedMenuIndex, setSelectedMenuIndex] = useState(-1)
		const [selectedType, setSelectedType] = useState<ContextMenuOptionType | null>(null)
		const [justDeletedSpaceAfterMention, setJustDeletedSpaceAfterMention] = useState(false)
		const [justDeletedSpaceAfterSlashCommand, setJustDeletedSpaceAfterSlashCommand] = useState(false)
		const [intendedCursorPosition, setIntendedCursorPosition] = useState<number | null>(null)
		const contextMenuContainerRef = useRef<HTMLDivElement>(null)

		const [shownTooltipMode, setShownTooltipMode] = useState<Mode | null>(null)
		const [pendingInsertions, setPendingInsertions] = useState<string[]>([])
		const _shiftHoldTimerRef = useRef<NodeJS.Timeout | null>(null)
		const [showDimensionError, setShowDimensionError] = useState(false)
		const dimensionErrorTimerRef = useRef<NodeJS.Timeout | null>(null)

		const [fileSearchResults, setFileSearchResults] = useState<SearchResult[]>([])
		const [searchLoading, setSearchLoading] = useState(false)
		const [, metaKeyChar] = useMetaKeyDetection(platform)
		const {
			showSlashCommandsMenu,
			selectedSlashCommandsIndex,
			setSelectedSlashCommandsIndex,
			slashCommandsQuery,
			handleSlashCommandsSelect,
			handleSlashMenuKeyDown,
			updateSlashCommandsMenu,
			closeSlashCommandsMenu,
		} = useSlashCommandMenu({
			inputValue,
			cursorPosition,
			setInputValue,
			setCursorPosition,
			setIntendedCursorPosition,
			textAreaRef,
			menuContainerRef: slashCommandsMenuContainerRef,
			localWorkflowToggles,
			globalWorkflowToggles,
			remoteWorkflowToggles,
			remoteGlobalWorkflows: remoteConfigSettings?.remoteGlobalWorkflows,
			mcpServers,
		})

		// Fetch git commits when Git is selected or when typing a hash
		useEffect(() => {
			if (selectedType === ContextMenuOptionType.Git || /^[a-f0-9]+$/i.test(searchQuery)) {
				FileServiceClient.searchCommits(StringRequest.create({ value: searchQuery || "" }))
					.then((response) => {
						if (response.commits) {
							const commits: GitCommit[] = response.commits.map(
								(commit: { hash: string; shortHash: string; subject: string; author: string; date: string }) => ({
									type: ContextMenuOptionType.Git,
									value: commit.hash,
									label: commit.subject,
									description: `${commit.shortHash} by ${commit.author} on ${commit.date}`,
								}),
							)
							setGitCommits(commits)
						}
					})
					.catch((error) => {
						console.error("Error searching commits:", error)
					})
			}
		}, [selectedType, searchQuery])

		const queryItems = useMemo(() => {
			return [
				{ type: ContextMenuOptionType.Problems, value: "problems" },
				{ type: ContextMenuOptionType.Terminal, value: "terminal" },
				...gitCommits,
			]
		}, [gitCommits])

		useEffect(() => {
			const handleClickOutside = (event: MouseEvent) => {
				if (contextMenuContainerRef.current && !contextMenuContainerRef.current.contains(event.target as Node)) {
					setShowContextMenu(false)
				}
			}

			if (showContextMenu) {
				document.addEventListener("mousedown", handleClickOutside)
			}

			return () => {
				document.removeEventListener("mousedown", handleClickOutside)
			}
		}, [showContextMenu, setShowContextMenu])

		const handleMentionSelect = useCallback(
			(type: ContextMenuOptionType, value?: string) => {
				if (type === ContextMenuOptionType.NoResults) {
					return
				}

				if (
					type === ContextMenuOptionType.File ||
					type === ContextMenuOptionType.Folder ||
					type === ContextMenuOptionType.Git
				) {
					if (!value) {
						setSelectedType(type)
						setSearchQuery("")
						setSelectedMenuIndex(0)

						// Trigger search with the selected type
						if (type === ContextMenuOptionType.File || type === ContextMenuOptionType.Folder) {
							setSearchLoading(true)

							// Map ContextMenuOptionType to FileSearchType enum
							let searchType: FileSearchType | undefined
							if (type === ContextMenuOptionType.File) {
								searchType = FileSearchType.FILE
							} else if (type === ContextMenuOptionType.Folder) {
								searchType = FileSearchType.FOLDER
							}

							const myToken = ++latestSearchTokenRef.current
							FileServiceClient.searchFiles(
								FileSearchRequest.create({
									query: "",
									mentionsRequestId: String(myToken),
									selectedType: searchType,
								}),
							)
								.then((results) => {
									if (myToken !== latestSearchTokenRef.current) {
										// Stale response — a newer search has been issued.
										return
									}
									setFileSearchResults((results.results || []) as SearchResult[])
									setSearchLoading(false)
								})
								.catch((error) => {
									if (myToken !== latestSearchTokenRef.current) {
										return
									}
									console.error("Error searching files:", error)
									setFileSearchResults([])
									setSearchLoading(false)
								})
						}
						return
					}
				}

				setShowContextMenu(false)
				setSelectedType(null)
				const queryLength = searchQuery.length
				setSearchQuery("")

				if (textAreaRef.current) {
					let insertValue = value || ""
					if (type === ContextMenuOptionType.URL) {
						insertValue = value || ""
					} else if (type === ContextMenuOptionType.File || type === ContextMenuOptionType.Folder) {
						insertValue = value || ""
					} else if (type === ContextMenuOptionType.Problems) {
						insertValue = "problems"
					} else if (type === ContextMenuOptionType.Terminal) {
						insertValue = "terminal"
					} else if (type === ContextMenuOptionType.Git) {
						insertValue = value || ""
					}

					const { newValue, mentionIndex } = insertMention(
						textAreaRef.current.value,
						cursorPosition,
						insertValue,
						queryLength,
					)

					setInputValue(newValue)
					const newCursorPosition = newValue.indexOf(" ", mentionIndex + insertValue.length) + 1
					setCursorPosition(newCursorPosition)
					setIntendedCursorPosition(newCursorPosition)
					// textAreaRef.current.focus()

					// scroll to cursor
					setTimeout(() => {
						if (textAreaRef.current) {
							textAreaRef.current.blur()
							textAreaRef.current.focus()
						}
					}, 0)
				}
			},
			[setInputValue, cursorPosition, searchQuery],
		)

		const handleKeyDown = useCallback(
			(event: React.KeyboardEvent<HTMLTextAreaElement>) => {
				const isSelectAllShortcut =
					(event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "a"
				if (isSelectAllShortcut) {
					event.preventDefault()
					event.stopPropagation()
					const textArea = event.currentTarget
					textArea.setSelectionRange(0, textArea.value.length)
					setCursorPosition(0)
					return
				}

				if (handleSlashMenuKeyDown(event)) {
					return
				}
				if (showContextMenu) {
					if (event.key === "Escape") {
						setShowContextMenu(false)
						setSelectedType(null)
						setSelectedMenuIndex(DEFAULT_CONTEXT_MENU_OPTION)
						setSearchQuery("")
						return
					}

					if (event.key === "ArrowUp" || event.key === "ArrowDown") {
						event.preventDefault()
						setSelectedMenuIndex((prevIndex) => {
							const direction = event.key === "ArrowUp" ? -1 : 1
							const options = getContextMenuOptions(searchQuery, selectedType, queryItems, fileSearchResults)
							const optionsLength = options.length

							if (optionsLength === 0) {
								return prevIndex
							}

							// Find selectable options (non-URL types)
							const selectableOptions = options.filter(
								(option) =>
									option.type !== ContextMenuOptionType.URL && option.type !== ContextMenuOptionType.NoResults,
							)

							if (selectableOptions.length === 0) {
								return -1 // No selectable options
							}

							// Find the index of the next selectable option
							const currentSelectableIndex = selectableOptions.indexOf(options[prevIndex])

							const newSelectableIndex =
								(currentSelectableIndex + direction + selectableOptions.length) % selectableOptions.length

							// Find the index of the selected option in the original options array
							return options.indexOf(selectableOptions[newSelectableIndex])
						})
						return
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
							// Use label if it contains workspace prefix, otherwise use value
							const mentionValue = selectedOption.label?.includes(":") ? selectedOption.label : selectedOption.value
							handleMentionSelect(selectedOption.type, mentionValue)
						}
						return
					}
				}

				// Safari does not support InputEvent.isComposing (always false), so we need to fallback to keyCode === 229 for it
				const isComposing = isSafari ? event.nativeEvent.keyCode === 229 : (event.nativeEvent?.isComposing ?? false)
				if (event.key === "Enter" && !event.shiftKey && !isComposing) {
					event.preventDefault()

					if (!sendingDisabled) {
						setIsTextAreaFocused(false)
						onSend()
					}
				}

				if (event.key === "Backspace" && !isComposing) {
					const charBeforeCursor = inputValue[cursorPosition - 1]
					const charAfterCursor = inputValue[cursorPosition + 1]

					const charBeforeIsWhitespace =
						charBeforeCursor === " " || charBeforeCursor === "\n" || charBeforeCursor === "\r\n"
					const charAfterIsWhitespace =
						charAfterCursor === " " || charAfterCursor === "\n" || charAfterCursor === "\r\n"

					// Check if we're right after a space that follows a mention or slash command
					if (
						charBeforeIsWhitespace &&
						inputValue.slice(0, cursorPosition - 1).match(new RegExp(mentionRegex.source + "$"))
					) {
						// File mention handling
						const newCursorPosition = cursorPosition - 1
						if (!charAfterIsWhitespace) {
							event.preventDefault()
							textAreaRef.current?.setSelectionRange(newCursorPosition, newCursorPosition)
							setCursorPosition(newCursorPosition)
						}
						setCursorPosition(newCursorPosition)
						setJustDeletedSpaceAfterMention(true)
						setJustDeletedSpaceAfterSlashCommand(false)
					} else if (charBeforeIsWhitespace && inputValue.slice(0, cursorPosition - 1).match(slashCommandDeleteRegex)) {
						// New slash command handling
						const newCursorPosition = cursorPosition - 1
						if (!charAfterIsWhitespace) {
							event.preventDefault()
							textAreaRef.current?.setSelectionRange(newCursorPosition, newCursorPosition)
							setCursorPosition(newCursorPosition)
						}
						setCursorPosition(newCursorPosition)
						setJustDeletedSpaceAfterSlashCommand(true)
						setJustDeletedSpaceAfterMention(false)
					}
					// Handle the second backspace press for mentions or slash commands
					else if (justDeletedSpaceAfterMention) {
						const { newText, newPosition } = removeMention(inputValue, cursorPosition)
						if (newText !== inputValue) {
							event.preventDefault()
							setInputValue(newText)
							setIntendedCursorPosition(newPosition)
						}
						setJustDeletedSpaceAfterMention(false)
						setShowContextMenu(false)
					} else if (justDeletedSpaceAfterSlashCommand) {
						// New slash command deletion
						const { newText, newPosition } = removeSlashCommand(inputValue, cursorPosition)
						if (newText !== inputValue) {
							event.preventDefault()
							setInputValue(newText)
							setIntendedCursorPosition(newPosition)
						}
						setJustDeletedSpaceAfterSlashCommand(false)
						closeSlashCommandsMenu()
					}
					// Default case - reset flags if none of the above apply
					else {
						setJustDeletedSpaceAfterMention(false)
						setJustDeletedSpaceAfterSlashCommand(false)
					}
				}
			},
			[
				onSend,
				showContextMenu,
				searchQuery,
				selectedMenuIndex,
				handleMentionSelect,
				selectedType,
				inputValue,
				cursorPosition,
				setInputValue,
				justDeletedSpaceAfterMention,
				justDeletedSpaceAfterSlashCommand,
				queryItems,
				fileSearchResults,
				handleSlashMenuKeyDown,
				closeSlashCommandsMenu,
				sendingDisabled,
			],
		)

		// Effect to set cursor position after state updates
		useLayoutEffect(() => {
			if (intendedCursorPosition !== null && textAreaRef.current) {
				textAreaRef.current.setSelectionRange(intendedCursorPosition, intendedCursorPosition)
				setIntendedCursorPosition(null) // Reset the state after applying
			}
		}, [inputValue, intendedCursorPosition])

		useEffect(() => {
			if (pendingInsertions.length === 0 || !textAreaRef.current) {
				return
			}

			const path = pendingInsertions[0]
			const currentTextArea = textAreaRef.current
			const currentValue = currentTextArea.value
			const currentCursorPos =
				intendedCursorPosition ??
				(currentTextArea.selectionStart >= 0 ? currentTextArea.selectionStart : currentValue.length)

			const { newValue, mentionIndex } = insertMentionDirectly(currentValue, currentCursorPos, path)

			setInputValue(newValue)

			const newCursorPosition = mentionIndex + path.length + 2
			setIntendedCursorPosition(newCursorPosition)

			setPendingInsertions((prev) => prev.slice(1))
		}, [pendingInsertions, setInputValue])

		const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null)

		// Monotonic token; every searchFiles dispatch bumps it, and resolve
		// handlers drop their result when the token they captured at fire time
		// is no longer the latest. Prevents stale results from a cancelled or
		// superseded picker (e.g. "Add File" still in flight when user picks
		// "Add Folder") from clobbering fresh state.
		const latestSearchTokenRef = useRef(0)

		const handleInputChange = useCallback(
			(e: React.ChangeEvent<HTMLTextAreaElement>) => {
				const newValue = e.target.value
				const newCursorPosition = e.target.selectionStart
				setInputValue(newValue)
				setCursorPosition(newCursorPosition)
				let showMenu = shouldShowContextMenu(newValue, newCursorPosition)
				const shouldShowSlashMenu = updateSlashCommandsMenu(newValue, newCursorPosition)

				// we do not allow both menus to be shown at the same time
				// the slash commands menu has precedence bc its a narrower component
				if (shouldShowSlashMenu) {
					showMenu = false
				}

				setShowContextMenu(showMenu)

				if (showMenu) {
					const lastAtIndex = newValue.lastIndexOf("@", newCursorPosition - 1)
					const query = newValue.slice(lastAtIndex + 1, newCursorPosition)
					setSearchQuery(query)

					if (query.length > 0) {
						setSelectedMenuIndex(0)

						// Clear any existing timeout
						if (searchTimeoutRef.current) {
							clearTimeout(searchTimeoutRef.current)
						}

						setSearchLoading(true)

						const searchType =
							selectedType === ContextMenuOptionType.File
								? FileSearchType.FILE
								: selectedType === ContextMenuOptionType.Folder
									? FileSearchType.FOLDER
									: undefined

						// Parse workspace hint from query (e.g., "@frontend:/filename")
						let workspaceHint: string | undefined
						let searchQuery = query
						const workspaceHintMatch = query.match(/^([\w-]+):\/(.*)$/)
						if (workspaceHintMatch) {
							workspaceHint = workspaceHintMatch[1]
							searchQuery = workspaceHintMatch[2]
						}

						// Set a timeout to debounce the search requests
						searchTimeoutRef.current = setTimeout(() => {
							const myToken = ++latestSearchTokenRef.current
							FileServiceClient.searchFiles(
								FileSearchRequest.create({
									query: searchQuery,
									mentionsRequestId: String(myToken),
									selectedType: searchType,
									workspaceHint: workspaceHint,
								}),
							)
								.then((results) => {
									if (myToken !== latestSearchTokenRef.current) {
										// Stale response — a newer search has been issued.
										return
									}
									setFileSearchResults((results.results || []) as SearchResult[])
									setSearchLoading(false)
								})
								.catch((error) => {
									if (myToken !== latestSearchTokenRef.current) {
										return
									}
									console.error("Error searching files:", error)
									setFileSearchResults([])
									setSearchLoading(false)
								})
						}, 200) // 200ms debounce
					} else {
						setSelectedMenuIndex(DEFAULT_CONTEXT_MENU_OPTION)
					}
				} else {
					setSearchQuery("")
					setSelectedMenuIndex(-1)
					setFileSearchResults([])
				}
			},
			[setInputValue, setFileSearchResults, selectedType, updateSlashCommandsMenu],
		)

		useEffect(() => {
			if (!showContextMenu) {
				setSelectedType(null)
			}
		}, [showContextMenu])

		const handleBlur = useCallback(() => {
			// Only hide the context menu if the user didn't click on it
			if (!isMouseDownOnMenu) {
				setShowContextMenu(false)
				closeSlashCommandsMenu()
			}
			setIsTextAreaFocused(false)
			onFocusChange?.(false) // Call prop on blur
		}, [isMouseDownOnMenu, onFocusChange, closeSlashCommandsMenu])

		const showDimensionErrorMessage = useCallback(() => {
			setShowDimensionError(true)
			if (dimensionErrorTimerRef.current) {
				clearTimeout(dimensionErrorTimerRef.current)
			}
			dimensionErrorTimerRef.current = setTimeout(() => {
				setShowDimensionError(false)
				dimensionErrorTimerRef.current = null
			}, 3000)
		}, [])

		const { isDraggingOver, showUnsupportedFileError, handleDragEnter, handleDragLeave, onDragOver, onDrop } =
			useChatDrop({
				inputValue,
				cursorPosition,
				setInputValue,
				setCursorPosition,
				setIntendedCursorPosition,
				setPendingInsertions,
				textAreaRef,
				modelSupportsImages,
				shouldDisableFilesAndImages,
				selectedImages,
				selectedFiles,
				setSelectedImages,
				showDimensionErrorMessage,
			})

		const handlePaste = useChatPaste({
			inputValue,
			cursorPosition,
			setInputValue,
			setCursorPosition,
			setIntendedCursorPosition,
			setShowContextMenu,
			textAreaRef,
			modelSupportsImages,
			shouldDisableFilesAndImages,
			selectedImages,
			selectedFiles,
			setSelectedImages,
			showDimensionErrorMessage,
		})

		const handleThumbnailsHeightChange = useCallback((height: number) => {
			setThumbnailsHeight(height)
		}, [])

		useEffect(() => {
			if (selectedImages.length === 0 && selectedFiles.length === 0) {
				setThumbnailsHeight(0)
			}
		}, [selectedImages, selectedFiles])

		const handleMenuMouseDown = useCallback(() => {
			setIsMouseDownOnMenu(true)
		}, [])

		const updateHighlights = useCallback(() => {
			if (!textAreaRef.current || !highlightLayerRef.current) {
				return
			}

			let processedText = textAreaRef.current.value

			processedText = processedText
				.replace(/\n$/, "\n\n")
				.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] || c)
				// highlight @mentions
				.replace(mentionRegexGlobal, '<mark class="mention-context-textarea-highlight">$&</mark>')

			// Highlight only the FIRST valid /slash-command in the text
			// Only one slash command is processed per message, so we only highlight the first one
			slashCommandRegexGlobal.lastIndex = 0
			let hasHighlightedSlashCommand = false
			processedText = processedText.replace(slashCommandRegexGlobal, (match, prefix, command) => {
				// Only highlight the first valid slash command
				if (hasHighlightedSlashCommand) {
					return match
				}

				// Extract just the command name (without the slash)
				const commandName = command.substring(1)
				const isValidCommand = validateSlashCommand(
					commandName,
					localWorkflowToggles,
					globalWorkflowToggles,
					remoteWorkflowToggles,
					remoteConfigSettings?.remoteGlobalWorkflows,
				)

				if (isValidCommand) {
					hasHighlightedSlashCommand = true
					// Keep the prefix (whitespace or empty) and wrap the command in highlight
					return `${prefix}<mark class="mention-context-textarea-highlight">${command}</mark>`
				}
				return match
			})

			highlightLayerRef.current.innerHTML = processedText
			highlightLayerRef.current.scrollTop = textAreaRef.current.scrollTop
			highlightLayerRef.current.scrollLeft = textAreaRef.current.scrollLeft
		}, [localWorkflowToggles, globalWorkflowToggles, remoteWorkflowToggles, remoteConfigSettings])

		useLayoutEffect(() => {
			updateHighlights()
		}, [inputValue, updateHighlights])

		const updateCursorPosition = useCallback(() => {
			if (textAreaRef.current) {
				setCursorPosition(textAreaRef.current.selectionStart)
			}
		}, [])

		const handleKeyUp = useCallback(
			(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
				if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
					updateCursorPosition()
				}
			},
			[updateCursorPosition],
		)

		const onModeToggle = useCallback(() => {
			void (async () => {
				const convertedProtoMode = mode === "plan" ? PlanActMode.ACT : PlanActMode.PLAN
				const response = await StateServiceClient.togglePlanActModeProto(
					TogglePlanActModeRequest.create({
						mode: convertedProtoMode,
						chatContent: {
							message: inputValue.trim() ? inputValue : undefined,
							images: selectedImages,
							files: selectedFiles,
						},
					}),
				)
				// Focus the textarea after mode toggle with slight delay
				setTimeout(() => {
					if (response.value) {
						setInputValue("")
					}
					textAreaRef.current?.focus()
				}, 100)
			})()
		}, [mode, inputValue, selectedImages, selectedFiles, setInputValue])

		useShortcut(usePlatform().togglePlanActKeys, onModeToggle, { disableTextInputs: false }) // important that we don't disable the text input here

		const handleContextButtonClick = useCallback(() => {
			// Focus the textarea first
			textAreaRef.current?.focus()
			const openContextMenu = () => {
				setSelectedType(null)
				setShowContextMenu(true)
			}

			// If input is empty, just insert @
			if (!inputValue.trim()) {
				const event = {
					target: {
						value: "@",
						selectionStart: 1,
					},
				} as React.ChangeEvent<HTMLTextAreaElement>
				handleInputChange(event)
				updateHighlights()
				openContextMenu()
				return
			}

			// If input ends with space or is empty, just append @
			if (inputValue.endsWith(" ")) {
				const event = {
					target: {
						value: inputValue + "@",
						selectionStart: inputValue.length + 1,
					},
				} as React.ChangeEvent<HTMLTextAreaElement>
				handleInputChange(event)
				updateHighlights()
				openContextMenu()
				return
			}

			// Otherwise add space then @
			const event = {
				target: {
					value: inputValue + " @",
					selectionStart: inputValue.length + 2,
				},
			} as React.ChangeEvent<HTMLTextAreaElement>
			handleInputChange(event)
			updateHighlights()
			openContextMenu()
		}, [inputValue, handleInputChange, updateHighlights])

		// Get model display name
		const modelDisplayName = useMemo(() => {
			const { selectedProvider, selectedModelId } = normalizeApiConfiguration(apiConfiguration, mode)
			const {
				vsCodeLmModelSelector,
				togetherModelId,
				lmStudioModelId,
				ollamaModelId,
				liteLlmModelId,
				requestyModelId,
				vercelAiGatewayModelId,
			} = getModeSpecificFields(apiConfiguration, mode)
			const unknownModel = "unknown"

			if (!apiConfiguration) {
				return unknownModel
			}
			switch (selectedProvider) {
				case "cline":
					return `${selectedProvider}:${selectedModelId}`
				case "openai":
					return `openai-compat:${selectedModelId}`
				case "vscode-lm":
					return `vscode-lm:${vsCodeLmModelSelector ? `${vsCodeLmModelSelector.vendor ?? ""}/${vsCodeLmModelSelector.family ?? ""}` : unknownModel}`
				case "together":
					return `${selectedProvider}:${togetherModelId}`
				case "lmstudio":
					return `${selectedProvider}:${lmStudioModelId}`
				case "ollama":
					return `${selectedProvider}:${ollamaModelId}`
				case "litellm":
					return `${selectedProvider}:${liteLlmModelId}`
				case "requesty":
					return `${selectedProvider}:${requestyModelId}`
				case "vercel-ai-gateway":
					return `${selectedProvider}:${vercelAiGatewayModelId || selectedModelId}`
				case "anthropic":
				case "openrouter":
				default:
					return `${selectedProvider}:${selectedModelId}`
			}
		}, [apiConfiguration, mode])

		// Replace Meta with the platform specific key and uppercase the command letter.
		const togglePlanActKeys = usePlatform()
			.togglePlanActKeys.replace("Meta", metaKeyChar)
			.replace(/.$/, (match) => match.toUpperCase())

		return (
			<div className="lig-input-section">
				<div
					className="lig-input-shell relative flex transition-colors ease-in-out duration-100 px-0 py-0"
					onDragEnter={handleDragEnter}
					onDragLeave={handleDragLeave}
					onDragOver={onDragOver}
					onDrop={onDrop}>
					{showDimensionError && (
						<div className="absolute inset-2.5 bg-[rgba(var(--vscode-errorForeground-rgb),0.1)] border-2 border-error rounded-xs flex items-center justify-center z-10 pointer-events-none">
							<span className="text-error font-bold text-xs text-center">Image dimensions exceed 7500px</span>
						</div>
					)}
					{showUnsupportedFileError && (
						<div className="absolute inset-2.5 bg-[rgba(var(--vscode-errorForeground-rgb),0.1)] border-2 border-error rounded-xs flex items-center justify-center z-10 pointer-events-none">
							<span className="text-error font-bold text-xs">Files other than images are currently disabled</span>
						</div>
					)}
					{showSlashCommandsMenu && (
						<div ref={slashCommandsMenuContainerRef}>
							<SlashCommandMenu
								globalWorkflowToggles={globalWorkflowToggles}
								localWorkflowToggles={localWorkflowToggles}
								mcpServers={mcpServers}
								onMouseDown={handleMenuMouseDown}
								onSelect={handleSlashCommandsSelect}
								query={slashCommandsQuery}
								remoteWorkflows={remoteConfigSettings?.remoteGlobalWorkflows}
								remoteWorkflowToggles={remoteWorkflowToggles}
								selectedIndex={selectedSlashCommandsIndex}
								setSelectedIndex={setSelectedSlashCommandsIndex}
							/>
						</div>
					)}

					{showContextMenu && (
						<div ref={contextMenuContainerRef}>
							<ContextMenu
								dynamicSearchResults={fileSearchResults}
								isLoading={searchLoading}
								onMouseDown={handleMenuMouseDown}
								onSelect={handleMentionSelect}
								queryItems={queryItems}
								searchQuery={searchQuery}
								selectedIndex={selectedMenuIndex}
								selectedType={selectedType}
								setSelectedIndex={setSelectedMenuIndex}
							/>
						</div>
					)}
					<div
						className={cn(
							"absolute bottom-0 top-0 whitespace-pre-wrap break-words rounded-[6px] overflow-hidden bg-transparent",
							isTextAreaFocused ? "left-0 right-0" : "left-0 right-0",
						)}
						ref={highlightLayerRef}
						style={{
							position: "absolute",
							pointerEvents: "none",
							whiteSpace: "pre-wrap",
							wordWrap: "break-word",
							color: "transparent",
							overflow: "hidden",
							fontFamily: "var(--lig-font-family)",
							fontSize: "var(--vscode-editor-font-size)",
							lineHeight: "var(--vscode-editor-line-height)",
							borderRadius: 2,
							borderLeft: isTextAreaFocused ? 0 : undefined,
							borderRight: isTextAreaFocused ? 0 : undefined,
							borderTop: isTextAreaFocused ? 0 : undefined,
							borderBottom: isTextAreaFocused ? 0 : undefined,
							padding: `11px 34px ${11 + thumbnailsHeight}px 11px`,
						}}
					/>
					<DynamicTextArea
						autoFocus={true}
						data-testid="chat-input"
						maxRows={10}
						minRows={3}
						onBlur={handleBlur}
						onChange={(e) => {
							handleInputChange(e)
							updateHighlights()
						}}
						onFocus={() => {
							setIsTextAreaFocused(true)
							onFocusChange?.(true) // Call prop on focus
						}}
						onHeightChange={(height) => {
							if (textAreaBaseHeight === undefined || height < textAreaBaseHeight) {
								setTextAreaBaseHeight(height)
							}
							onHeightChange?.(height)
						}}
						onKeyDown={handleKeyDown}
						onKeyUp={handleKeyUp}
						onMouseUp={updateCursorPosition}
						onPaste={handlePaste}
						onScroll={() => updateHighlights()}
						onSelect={updateCursorPosition}
						placeholder={showUnsupportedFileError || showDimensionError ? "" : placeholderText}
						ref={(el) => {
							if (typeof ref === "function") {
								ref(el)
							} else if (ref) {
								ref.current = el
							}
							textAreaRef.current = el
						}}
						style={{
							width: "100%",
							boxSizing: "border-box",
							backgroundColor: "transparent",
							color: "var(--vscode-input-foreground)",
							//border: "1px solid var(--vscode-input-border)",
							borderRadius: 2,
							fontFamily: "var(--lig-font-family)",
							fontSize: "var(--vscode-editor-font-size)",
							lineHeight: "var(--vscode-editor-line-height)",
							resize: "none",
							overflowX: "hidden",
							overflowY: "scroll",
							scrollbarWidth: "none",
							// Since we have maxRows, when text is long enough it starts to overflow the bottom padding, appearing behind the thumbnails. To fix this, we use a transparent border to push the text up instead. (https://stackoverflow.com/questions/42631947/maintaining-a-padding-inside-of-text-area/52538410#52538410)
							// borderTop: "9px solid transparent",
							borderLeft: 0,
							borderRight: 0,
							borderTop: 0,
							borderBottom: `${thumbnailsHeight}px solid transparent`,
							borderColor: "transparent",
							// borderRight: "54px solid transparent",
							// borderLeft: "9px solid transparent", // NOTE: react-textarea-autosize doesn't calculate correct height when using borderLeft/borderRight so we need to use horizontal padding instead
							// Instead of using boxShadow, we use a div with a border to better replicate the behavior when the textarea is focused
							// boxShadow: "0px 0px 0px 1px var(--vscode-input-border)",
							padding: "11px 34px 11px 11px",
							cursor: "text",
							flex: 1,
							zIndex: 1,
							outline:
								isDraggingOver && !showUnsupportedFileError // Only show drag outline if not showing error
									? "2px dashed var(--vscode-focusBorder)"
									: "none",
							outlineOffset: isDraggingOver && !showUnsupportedFileError ? "1px" : "0px", // Add offset for drag-over outline
						}}
						value={inputValue}
					/>
					{!inputValue && selectedImages.length === 0 && selectedFiles.length === 0 && (
						<div className="text-xs absolute bottom-5 left-4 right-16 text-(--vscode-input-placeholderForeground)/55 whitespace-nowrap overflow-hidden text-ellipsis pointer-events-none z-1">
							Type @ for context, / for slash commands & workflows, hold shift to drag in files/images
						</div>
					)}
					{(selectedImages.length > 0 || selectedFiles.length > 0) && (
						<Thumbnails
							files={selectedFiles}
							images={selectedImages}
							onHeightChange={handleThumbnailsHeightChange}
							setFiles={setSelectedFiles}
							setImages={setSelectedImages}
							style={{
								position: "absolute",
								paddingTop: 4,
								bottom: 14,
								left: 22,
								right: 47, // (54 + 9) + 4 extra padding
								zIndex: 2,
							}}
						/>
					)}
					<div
						className="absolute flex items-end bottom-4.5 right-5 z-10 h-8 text-xs"
						style={{ height: textAreaBaseHeight }}>
						<div className="flex flex-row items-center">
							<div
								aria-label={requestPending ? t("common.cancel") : t("chat.send")}
								className={cn(
									"lig-input-send input-icon-button",
									{ disabled: sendingDisabled && !requestPending },
									"codicon text-sm",
									requestPending ? "codicon-debug-stop" : "codicon-send",
								)}
								data-testid={requestPending ? "cancel-send-button" : "send-button"}
								onClick={() => {
									if (requestPending) {
										onCancelRequest?.()
										return
									}
									if (!sendingDisabled) {
										setIsTextAreaFocused(false)
										onSend()
									}
								}}
								role="button"
								title={requestPending ? t("common.cancel") : t("chat.send")}
							/>
						</div>
					</div>
				</div>
				<div className="lig-input-toolbar flex justify-between items-center mt-1.5">
					{/* Always render both components, but control visibility with CSS */}
					<div className="relative flex-1 min-w-0 h-5">
						{/* ButtonGroup - always in DOM but visibility controlled */}
						<ButtonGroup className="absolute top-0 left-0 right-0 ease-in-out w-full h-5 z-10 flex items-center">
							<Tooltip>
								<TooltipContent>{t("chat.addContext")}</TooltipContent>
								<TooltipTrigger>
									<VSCodeButton
										appearance="icon"
										aria-label={t("chat.addContext")}
										className="p-0 m-0 flex items-center"
										data-testid="context-button"
										onClick={handleContextButtonClick}>
										<ButtonContainer>
											<AtSignIcon size={12} />
										</ButtonContainer>
									</VSCodeButton>
								</TooltipTrigger>
							</Tooltip>

							<Tooltip>
								<TooltipContent>{t("chat.addFilesImages")}</TooltipContent>
								<TooltipTrigger>
									<VSCodeButton
										appearance="icon"
										aria-label={t("chat.addFilesImages")}
										className="p-0 m-0 flex items-center"
										data-testid="files-button"
										disabled={shouldDisableFilesAndImages}
										onClick={() => {
											if (!shouldDisableFilesAndImages) {
												onSelectFilesAndImages()
											}
										}}>
										<ButtonContainer>
											<PlusIcon size={13} />
										</ButtonContainer>
									</VSCodeButton>
								</TooltipTrigger>
							</Tooltip>

							<ServersToggleModal />

							<ClineRulesToggleModal />

							<ModelContainer>
								<ModelTextWrapper>
									<ModelDisplayText title={modelDisplayName}>
										<ModelButtonContent className="text-xs">{modelDisplayName}</ModelButtonContent>
									</ModelDisplayText>
								</ModelTextWrapper>
							</ModelContainer>
						</ButtonGroup>
					</div>
					<Tooltip>
						<TooltipContent>{t("common.settings")}</TooltipContent>
						<TooltipTrigger>
							<VSCodeButton
								appearance="icon"
								aria-label={t("common.settings")}
								className="p-0 m-0 mr-1 shrink-0 flex items-center"
								onClick={() => navigateToSettings()}
								data-testid="settings-button">
								<ButtonContainer>
									<Settings size={13} />
								</ButtonContainer>
							</VSCodeButton>
						</TooltipTrigger>
					</Tooltip>
					{/* Tooltip for Plan/Act toggle remains outside the conditional rendering */}
					<Tooltip>
						<TooltipContent
							className="text-xs px-2 flex flex-col gap-1"
							hidden={shownTooltipMode === null}
							side="top">
							{shownTooltipMode === "act" ? t("chat.actModeTooltip") : t("chat.planModeTooltip")}
							<p className="text-description/80 text-xs mb-0">
								{t("chat.toggleWith", { keys: "" })}
								<kbd className="text-muted-foreground mx-1">{togglePlanActKeys}</kbd>
							</p>
						</TooltipContent>
						<TooltipTrigger>
							<SwitchContainer data-testid="mode-switch" disabled={false} onClick={onModeToggle}>
								<Slider isAct={mode === "act"} />
								{(["plan", "act"] as const).map((m) => (
									<div
										aria-checked={mode === m}
										aria-label={t(mode === m ? "chat.modeActive" : "chat.modeInactive", {
											mode: m === "plan" ? t("chat.plan") : t("chat.act"),
										})}
										className={cn(
											"pt-0.5 pb-px px-2 z-10 text-xs w-1/2 text-center bg-transparent transition-colors",
										mode === m ? "text-(--lig-mode-active-foreground) font-semibold" : "text-input-foreground",
										)}
										onMouseLeave={() => setShownTooltipMode(null)}
										onMouseOver={() => setShownTooltipMode(m)}
										role="switch">
										{m === "plan" ? t("chat.plan") : t("chat.act")}
									</div>
								))}
							</SwitchContainer>
						</TooltipTrigger>
					</Tooltip>
				</div>
			</div>
		)
	},
)

export default ChatTextArea
