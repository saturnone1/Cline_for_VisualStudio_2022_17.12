type Message = Record<string, unknown>

export function projectAssistantTranscript(text: string): Message {
	const question = parseStructuredQuestion(text)
	if (!question) return { type: "say", say: "text", text }
	return {
		type: "ask",
		ask: "followup",
		text: JSON.stringify(question),
	}
}

export function parseStructuredQuestion(text: string): { question: string; options: string[] } | undefined {
	const candidate = unwrapJsonFence(text.trim())
	if (!candidate.startsWith("{") || !candidate.endsWith("}")) return undefined
	try {
		const value: unknown = JSON.parse(candidate)
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
		const record = value as Record<string, unknown>
		if (Object.keys(record).some((key) => key !== "question" && key !== "options")) return undefined
		if (typeof record.question !== "string" || !Array.isArray(record.options)) return undefined
		const question = record.question.trim()
		const options = record.options.map((option) => typeof option === "string" ? option.trim() : "")
		if (!question || options.length === 0 || options.some((option) => !option)) return undefined
		return { question, options: [...new Set(options)] }
	} catch {
		return undefined
	}
}

function unwrapJsonFence(text: string) {
	const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text)
	return match?.[1]?.trim() || text
}
