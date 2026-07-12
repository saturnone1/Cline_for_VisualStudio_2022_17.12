import { FileSearchRequest, FileSearchType } from "@shared/proto/cline/file"
import { useCallback, useEffect, useRef, useState } from "react"
import { FileServiceClient } from "@/services/grpcClient"
import { ContextMenuOptionType, type SearchResult } from "@/utils/contextMentions"

export interface MentionSearchQuery {
	query: string
	workspaceHint?: string
}

export function parseMentionSearchQuery(value: string): MentionSearchQuery {
	const match = value.match(/^([\w-]+):\/(.*)$/)
	return match ? { workspaceHint: match[1], query: match[2] } : { query: value }
}

function fileSearchType(type: ContextMenuOptionType | null): FileSearchType | undefined {
	if (type === ContextMenuOptionType.File) return FileSearchType.FILE
	if (type === ContextMenuOptionType.Folder) return FileSearchType.FOLDER
	return undefined
}

export function useMentionSearch() {
	const [fileSearchResults, setFileSearchResults] = useState<SearchResult[]>([])
	const [searchLoading, setSearchLoading] = useState(false)
	const latestTokenRef = useRef(0)
	const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

	const cancelMentionSearch = useCallback(() => {
		latestTokenRef.current++
		if (timeoutRef.current) {
			clearTimeout(timeoutRef.current)
			timeoutRef.current = null
		}
		setSearchLoading(false)
	}, [])

	const clearMentionSearch = useCallback(() => {
		cancelMentionSearch()
		setFileSearchResults([])
	}, [cancelMentionSearch])

	const runSearch = useCallback(async (value: string, selectedType: ContextMenuOptionType | null) => {
		const token = ++latestTokenRef.current
		const { query, workspaceHint } = parseMentionSearchQuery(value)
		setSearchLoading(true)
		try {
			const response = await FileServiceClient.searchFiles(
				FileSearchRequest.create({
					query,
					mentionsRequestId: String(token),
					selectedType: fileSearchType(selectedType),
					workspaceHint,
				}),
			)
			if (token === latestTokenRef.current) {
				setFileSearchResults((response.results || []) as SearchResult[])
				setSearchLoading(false)
			}
		} catch (error) {
			if (token === latestTokenRef.current) {
				console.error("Error searching files:", error)
				setFileSearchResults([])
				setSearchLoading(false)
			}
		}
	}, [])

	const scheduleMentionSearch = useCallback(
		(value: string, selectedType: ContextMenuOptionType | null, delay = 200) => {
			cancelMentionSearch()
			setSearchLoading(true)
			timeoutRef.current = setTimeout(() => {
				timeoutRef.current = null
				void runSearch(value, selectedType)
			}, delay)
		},
		[cancelMentionSearch, runSearch],
	)

	useEffect(() => cancelMentionSearch, [cancelMentionSearch])

	return {
		fileSearchResults,
		searchLoading,
		runMentionSearch: runSearch,
		scheduleMentionSearch,
		clearMentionSearch,
	}
}
