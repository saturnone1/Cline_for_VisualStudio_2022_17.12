export function taskTranscriptStorageBytes(messages: readonly Record<string, unknown>[]) {
	try {
		return Buffer.byteLength(JSON.stringify(messages), "utf8")
	} catch {
		return 0
	}
}

export function projectedTaskStorageBytes(value: unknown) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return 0
	const record = value as Record<string, unknown>
	for (const candidate of [record.storageBytes, record.ligVsStorageBytes, asRecord(record.metadata).ligVsStorageBytes]) {
		if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) return candidate
	}
	return 0
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
