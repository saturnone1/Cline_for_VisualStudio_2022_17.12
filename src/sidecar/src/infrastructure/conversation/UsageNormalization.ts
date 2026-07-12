export type NormalizedUsage = {
	inputTokens?: number
	outputTokens?: number
	cacheReadTokens?: number
	cacheWriteTokens?: number
	totalCost?: number
	reliable: boolean
}

export function normalizeUsageSnapshot(value: unknown): NormalizedUsage {
	const usage = asRecord(value)
	const normalized: NormalizedUsage = {
		inputTokens: firstNumberValue(usage, ["inputTokens", "tokensIn", "promptTokens", "totalInputTokens"]),
		outputTokens: firstNumberValue(usage, ["outputTokens", "tokensOut", "completionTokens", "totalOutputTokens"]),
		cacheReadTokens: firstNumberValue(usage, ["cacheReadTokens", "cacheReads", "cache_read_tokens", "totalCacheReadTokens"]),
		cacheWriteTokens: firstNumberValue(usage, ["cacheWriteTokens", "cacheWrites", "cache_creation_input_tokens", "totalCacheWriteTokens"]),
		totalCost: firstNumberValue(usage, ["totalCost", "cost"]),
		reliable: false,
	}
	normalized.reliable = (normalized.inputTokens || 0) + (normalized.outputTokens || 0) + (normalized.cacheReadTokens || 0) + (normalized.cacheWriteTokens || 0) > 0 || (normalized.totalCost || 0) > 0
	return normalized
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function firstNumberValue(record: Record<string, unknown>, keys: string[]) {
	for (const key of keys) {
		const value = record[key]
		if (typeof value === "number" && Number.isFinite(value)) return value
	}
	return undefined
}
