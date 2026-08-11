export type PatchChange = {
	path: string
	moveTo?: string
	action: "created" | "modified" | "deleted"
}

export function countLineChanges(before: string, after: string) {
	const beforeLines = splitLinesForDiff(before)
	const afterLines = splitLinesForDiff(after)
	const cellCount = beforeLines.length * afterLines.length
	if (cellCount > 1_000_000) {
		return {
			additions: Math.max(afterLines.length - beforeLines.length, 0),
			deletions: Math.max(beforeLines.length - afterLines.length, 0),
		}
	}

	let previous = new Array(afterLines.length + 1).fill(0)
	for (let i = 1; i <= beforeLines.length; i++) {
		const current = new Array(afterLines.length + 1).fill(0)
		for (let j = 1; j <= afterLines.length; j++) {
			current[j] = beforeLines[i - 1] === afterLines[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1])
		}
		previous = current
	}

	const common = previous[afterLines.length]
	return {
		additions: Math.max(afterLines.length - common, 0),
		deletions: Math.max(beforeLines.length - common, 0),
	}
}

export function parseApplyPatchChanges(patchText: string): PatchChange[] {
	const changes: PatchChange[] = []
	let current: PatchChange | null = null
	const pushCurrent = () => {
		if (current) {
			changes.push(current)
			current = null
		}
	}

	for (const rawLine of patchText.split(/\r?\n/)) {
		const line = rawLine.trimEnd()
		if (line.startsWith("*** Add File: ")) {
			pushCurrent()
			current = { path: line.slice("*** Add File: ".length).trim(), action: "created" }
		} else if (line.startsWith("*** Update File: ")) {
			pushCurrent()
			current = { path: line.slice("*** Update File: ".length).trim(), action: "modified" }
		} else if (line.startsWith("*** Delete File: ")) {
			pushCurrent()
			changes.push({ path: line.slice("*** Delete File: ".length).trim(), action: "deleted" })
		} else if (line.startsWith("*** Move to: ") && current) {
			current.moveTo = line.slice("*** Move to: ".length).trim()
		}
	}
	pushCurrent()
	return changes.filter((change) => change.path.length > 0)
}

function splitLinesForDiff(value: string) {
	if (!value) {
		return []
	}
	return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")
}
