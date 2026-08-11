import { RelativePathsRequest } from "@shared/proto/cline/file"
import { type Dispatch, type DragEvent, type RefObject, type SetStateAction, useCallback, useEffect, useRef, useState } from "react"
import { CHAT_CONSTANTS } from "@/components/chat/chatViewCore/constants"
import { FileServiceClient } from "@/services/grpcClient"

const { MAX_IMAGES_AND_FILES_PER_MESSAGE } = CHAT_CONSTANTS

export function getImageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
	return new Promise((resolve, reject) => {
		const image = new Image()
		image.onload = () => {
			if (image.naturalWidth > 7500 || image.naturalHeight > 7500) {
				reject(new Error("Image dimensions exceed maximum allowed size of 7500px."))
			} else {
				resolve({ width: image.naturalWidth, height: image.naturalHeight })
			}
		}
		image.onerror = (error) => {
			console.error("Failed to load image for dimension check:", error)
			reject(new Error("Failed to load image to check dimensions."))
		}
		image.src = dataUrl
	})
}

export function parseDroppedUris(resourceUrlsData: string, uriListData: string): string[] {
	let uris: string[] = []
	if (resourceUrlsData) {
		try {
			uris = (JSON.parse(resourceUrlsData) as string[]).map((uri) => decodeURIComponent(uri))
		} catch (error) {
			console.error("Failed to parse resourceurls JSON:", error)
		}
	}
	if (uris.length === 0 && uriListData) {
		uris = uriListData.split("\n").map((uri) => uri.trim())
	}
	return uris.filter(
		(uri) => uri && (uri.startsWith("vscode-file:") || uri.startsWith("file:") || uri.startsWith("vscode-remote:")),
	)
}

interface UseChatDropOptions {
	inputValue: string
	cursorPosition: number
	setInputValue: (value: string) => void
	setCursorPosition: (value: number) => void
	setIntendedCursorPosition: (value: number | null) => void
	setPendingInsertions: Dispatch<SetStateAction<string[]>>
	textAreaRef: RefObject<HTMLTextAreaElement | null>
	modelSupportsImages: boolean
	shouldDisableFilesAndImages: boolean
	selectedImages: string[]
	selectedFiles: string[]
	setSelectedImages: Dispatch<SetStateAction<string[]>>
	showDimensionErrorMessage: () => void
}

export function useChatDrop(options: UseChatDropOptions) {
	const [isDraggingOver, setIsDraggingOver] = useState(false)
	const [showUnsupportedFileError, setShowUnsupportedFileError] = useState(false)
	const unsupportedFileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

	const showUnsupportedFileErrorMessage = useCallback(() => {
		setShowUnsupportedFileError(true)
		if (unsupportedFileTimerRef.current) {
			clearTimeout(unsupportedFileTimerRef.current)
		}
		unsupportedFileTimerRef.current = setTimeout(() => {
			setShowUnsupportedFileError(false)
			unsupportedFileTimerRef.current = null
		}, 3000)
	}, [])

	const handleDragEnter = useCallback(
		(event: DragEvent) => {
			event.preventDefault()
			setIsDraggingOver(true)
			const hasNonImageFile = Array.from(event.dataTransfer.items).some(
				(item) => item.kind === "file" && item.type.split("/")[0] !== "image",
			)
			if (event.dataTransfer.types.includes("Files") && hasNonImageFile) {
				showUnsupportedFileErrorMessage()
			}
		},
		[showUnsupportedFileErrorMessage],
	)

	const onDragOver = useCallback((event: DragEvent) => {
		event.preventDefault()
		setIsDraggingOver(true)
	}, [])

	const handleDragLeave = useCallback((event: DragEvent) => {
		event.preventDefault()
		if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node)) {
			setIsDraggingOver(false)
		}
	}, [])

	useEffect(() => {
		const handleGlobalDragEnd = () => setIsDraggingOver(false)
		document.addEventListener("dragend", handleGlobalDragEnd)
		return () => {
			document.removeEventListener("dragend", handleGlobalDragEnd)
			if (unsupportedFileTimerRef.current) {
				clearTimeout(unsupportedFileTimerRef.current)
			}
		}
	}, [])

	const readImageFiles = useCallback(
		(imageFiles: File[]): Promise<Array<string | null>> =>
			Promise.all(
				imageFiles.map(
					(file) =>
						new Promise<string | null>((resolve) => {
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
							reader.readAsDataURL(file)
						}),
				),
			),
		[options.showDimensionErrorMessage],
	)

	const onDrop = useCallback(
		async (event: DragEvent) => {
			event.preventDefault()
			setIsDraggingOver(false)
			setShowUnsupportedFileError(false)
			if (unsupportedFileTimerRef.current) {
				clearTimeout(unsupportedFileTimerRef.current)
				unsupportedFileTimerRef.current = null
			}

			const resourceUrlsData = event.dataTransfer.getData("resourceurls")
			const uriListData = event.dataTransfer.getData("application/vnd.code.uri-list")
			const validUris = parseDroppedUris(resourceUrlsData, uriListData)
			if (validUris.length > 0) {
				options.setPendingInsertions([])
				options.setIntendedCursorPosition(options.textAreaRef.current?.selectionStart ?? options.inputValue.length)
				FileServiceClient.getRelativePaths(RelativePathsRequest.create({ uris: validUris }))
					.then((response) => {
						if (response.paths.length > 0) {
							options.setPendingInsertions((previous) => [...previous, ...response.paths])
						}
					})
					.catch((error) => console.error("Error getting relative paths:", error))
				return
			}

			const text = event.dataTransfer.getData("text")
			if (text) {
				const value = options.inputValue.slice(0, options.cursorPosition) + text + options.inputValue.slice(options.cursorPosition)
				const position = options.cursorPosition + text.length
				options.setInputValue(value)
				options.setCursorPosition(position)
				options.setIntendedCursorPosition(position)
				return
			}

			const imageFiles = Array.from(event.dataTransfer.files).filter((file) => {
				const [type, subtype] = file.type.split("/")
				return type === "image" && ["png", "jpeg", "webp"].includes(subtype)
			})
			if (!options.modelSupportsImages || options.shouldDisableFilesAndImages || imageFiles.length === 0) {
				return
			}
			const dataUrls = (await readImageFiles(imageFiles)).filter((dataUrl): dataUrl is string => dataUrl !== null)
			const availableSlots =
				MAX_IMAGES_AND_FILES_PER_MESSAGE - options.selectedImages.length - options.selectedFiles.length
			if (availableSlots > 0 && dataUrls.length > 0) {
				options.setSelectedImages((previous) => [...previous, ...dataUrls.slice(0, availableSlots)])
			}
		},
		[options, readImageFiles],
	)

	return { isDraggingOver, showUnsupportedFileError, handleDragEnter, handleDragLeave, onDragOver, onDrop }
}
