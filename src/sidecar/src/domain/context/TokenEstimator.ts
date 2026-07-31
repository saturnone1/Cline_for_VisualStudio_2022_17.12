export function estimateTextTokens(text: string) {
	const normalized = text.trim()
	if (!normalized) return 0
	let cjkChars = 0, wordChars = 0, symbols = 0
	for (const char of normalized) {
		const codePoint = char.codePointAt(0) ?? 0
		if (isCjk(codePoint)) cjkChars++
		else if (/\s/u.test(char)) continue
		else if (/[\p{L}\p{N}_]/u.test(char)) wordChars++
		else symbols++
	}
	return Math.ceil(cjkChars + wordChars / 4 + symbols / 2)
}

export function chunkTextByTokenBudget(value: string, maxTokens: number) {
	if (estimateTextTokens(value) <= maxTokens) return [value]
	const chunks: string[] = []
	let start = 0
	while (start < value.length) {
		let low = start + 1
		let high = Math.min(value.length, start + maxTokens * 4)
		let end = low
		while (low <= high) {
			const middle = (low + high) >>> 1
			if (estimateTextTokens(value.slice(start, middle)) <= maxTokens) { end = middle; low = middle + 1 }
			else high = middle - 1
		}
		if (end < value.length) {
			const boundary = value.lastIndexOf("\n\n", end)
			if (boundary > start + Math.floor((end - start) / 2)) end = boundary
		}
		chunks.push(value.slice(start, end))
		start = end
		while (value.startsWith("\n", start)) start++
	}
	return chunks
}

export function truncateTextByTokenBudget(value: string, maxTokens: number) {
	if (maxTokens <= 0) return ""
	if (estimateTextTokens(value) <= maxTokens) return value
	let low = 0, high = value.length, end = 0
	while (low <= high) {
		const middle = (low + high) >>> 1
		if (estimateTextTokens(value.slice(0, middle)) <= maxTokens) { end = middle; low = middle + 1 }
		else high = middle - 1
	}
	return value.slice(0, end)
}

function isCjk(codePoint: number) {
	return (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
		(codePoint >= 0x3400 && codePoint <= 0x9fff) ||
		(codePoint >= 0xac00 && codePoint <= 0xd7af) ||
		(codePoint >= 0xf900 && codePoint <= 0xfaff)
}
