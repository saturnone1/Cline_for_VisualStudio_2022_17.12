export function mergeTextDelta(current: string, delta: string) {
	if (!delta) return current
	if (!current) return delta
	return current.endsWith(delta) ? current : current + delta
}

export function looksLikeTokenizedReasoning(lines: string[]) {
	if (lines.length < 5) return false
	const shortLines = lines.filter((line) => line.length <= 16).length
	const wordLikeShortLines = lines.filter((line) => /^[\p{L}\p{N}"().,!?-]+$/u.test(line) && line.length <= 12).length
	const avgLength = lines.reduce((total, line) => total + line.length, 0) / lines.length
	return (shortLines / lines.length >= 0.72 && avgLength <= 12) || wordLikeShortLines / lines.length >= 0.6
}

export function looksLikeReasoningNarration(text: string) {
	const normalized = text.replace(/\s+/g, " ").trim().toLowerCase()
	return normalized.startsWith("the user says") || normalized.startsWith("user says") ||
		normalized.startsWith("no specific task") || normalized.includes(" the user says ") ||
		normalized.startsWith("we need to") || normalized.startsWith("probably ") ||
		normalized.startsWith("let's ") || normalized.startsWith("i need to")
}

export function isToolTranscript(text: string) {
	const normalized = text.trim()
	return normalized.startsWith("Tool:") || normalized.startsWith("Tool result:")
}

export function stringifyPretty(value: unknown) {
	if (typeof value === "string") return value
	try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

export function normalizeTranscriptText(text: string) {
	return text.replace(/\s+/g, " ").trim()
}
