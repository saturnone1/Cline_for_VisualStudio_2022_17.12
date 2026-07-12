import { type ClipboardEvent, type Dispatch, type RefObject, type SetStateAction, useCallback } from "react"
import { CHAT_CONSTANTS } from "@/components/chat/chatViewCore/constants"
import { getImageDimensions } from "./useChatDrop"

const { MAX_IMAGES_AND_FILES_PER_MESSAGE } = CHAT_CONSTANTS

export function insertPastedUrl(inputValue: string, cursorPosition: number, pastedText: string) {
	const trimmedUrl = pastedText.trim()
	return {
		value: inputValue.slice(0, cursorPosition) + trimmedUrl + " " + inputValue.slice(cursorPosition),
		cursorPosition: cursorPosition + trimmedUrl.length + 1,
	}
}

interface UseChatPasteOptions {
	inputValue: string
	cursorPosition: number
	setInputValue: (value: string) => void
	setCursorPosition: (value: number) => void
	setIntendedCursorPosition: (value: number | null) => void
	setShowContextMenu: (value: boolean) => void
	textAreaRef: RefObject<HTMLTextAreaElement | null>
	modelSupportsImages: boolean
	shouldDisableFilesAndImages: boolean
	selectedImages: string[]
	selectedFiles: string[]
	setSelectedImages: Dispatch<SetStateAction<string[]>>
	showDimensionErrorMessage: () => void
}

export function useChatPaste(options: UseChatPasteOptions) {
	return useCallback(
		async (event: ClipboardEvent) => {
			const pastedText = event.clipboardData.getData("text")
			if (/^\S+:\/\/\S+$/.test(pastedText.trim())) {
				event.preventDefault()
				const insertion = insertPastedUrl(options.inputValue, options.cursorPosition, pastedText)
				options.setInputValue(insertion.value)
				options.setCursorPosition(insertion.cursorPosition)
				options.setIntendedCursorPosition(insertion.cursorPosition)
				options.setShowContextMenu(false)
				setTimeout(() => {
					options.textAreaRef.current?.blur()
					options.textAreaRef.current?.focus()
				}, 0)
				return
			}

			const imageItems = Array.from(event.clipboardData.items).filter((item) => {
				const [type, subtype] = item.type.split("/")
				return type === "image" && ["png", "jpeg", "webp"].includes(subtype)
			})
			if (!options.modelSupportsImages || options.shouldDisableFilesAndImages || imageItems.length === 0) {
				return
			}

			event.preventDefault()
			const dataUrls = (
				await Promise.all(
					imageItems.map(
						(item) =>
							new Promise<string | null>((resolve) => {
								const blob = item.getAsFile()
								if (!blob) {
									resolve(null)
									return
								}
								const reader = new FileReader()
								reader.onloadend = async () => {
									if (reader.error || typeof reader.result !== "string") {
										resolve(null)
										return
									}
									try {
										await getImageDimensions(reader.result)
										resolve(reader.result)
									} catch (error) {
										console.warn((error as Error).message)
										options.showDimensionErrorMessage()
										resolve(null)
									}
								}
								reader.readAsDataURL(blob)
							}),
					),
				)
			).filter((dataUrl): dataUrl is string => dataUrl !== null)

			const availableSlots =
				MAX_IMAGES_AND_FILES_PER_MESSAGE - options.selectedImages.length - options.selectedFiles.length
			if (availableSlots > 0 && dataUrls.length > 0) {
				options.setSelectedImages((previous) => [...previous, ...dataUrls.slice(0, availableSlots)])
			}
		},
		[options],
	)
}
