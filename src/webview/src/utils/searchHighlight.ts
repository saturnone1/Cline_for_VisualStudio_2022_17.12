import type { FuseResult } from "fuse.js"

const mergeRegions = (regions: [number, number][]): [number, number][] => {
	if (regions.length === 0) return regions

	const sorted = [...regions].sort((a, b) => a[0] - b[0])
	const merged: [number, number][] = [[...sorted[0]]]

	for (let index = 1; index < sorted.length; index++) {
		const last = merged[merged.length - 1]
		const current = sorted[index]
		if (current[0] <= last[1] + 1) {
			last[1] = Math.max(last[1], current[1])
		} else {
			merged.push([...current])
		}
	}

	return merged
}

const setNestedValue = (target: Record<string, any>, path: string, value: any) => {
	const segments = path.split(".")
	let parent = target
	for (let index = 0; index < segments.length - 1; index++) {
		const next = parent[segments[index]]
		if (!next || typeof next !== "object") return
		parent = next as Record<string, any>
	}
	parent[segments[segments.length - 1]] = value
}

const escapeHtml = (value: string) =>
	value.replace(/[&<>"']/g, (character) => {
		switch (character) {
			case "&": return "&amp;"
			case "<": return "&lt;"
			case ">": return "&gt;"
			case '"': return "&quot;"
			default: return "&#39;"
		}
	})

const renderHighlightedText = (text: string, regions: [number, number][], className: string) => {
	let content = ""
	let cursor = 0
	const safeClassName = escapeHtml(className)

	for (const [start, end] of mergeRegions(regions)) {
		content += `${escapeHtml(text.substring(cursor, start))}<span class="${safeClassName}">${escapeHtml(text.substring(start, end + 1))}</span>`
		cursor = end + 1
	}

	return content + escapeHtml(text.substring(cursor))
}

export const escapeSearchResultText = escapeHtml

export const highlightSearchResults = <T extends Record<string, any>>(
	results: FuseResult<T>[],
	highlightClassName = "history-item-highlight",
): T[] =>
	results
		.filter(({ matches }) => Boolean(matches?.length))
		.map(({ item, matches }) => {
			const highlightedItem = { ...item }
			for (const match of matches ?? []) {
				if (match.key && typeof match.value === "string" && match.indices) {
					setNestedValue(
						highlightedItem,
						match.key,
						renderHighlightedText(match.value, [...match.indices], highlightClassName),
					)
				}
			}
			return highlightedItem
		})

