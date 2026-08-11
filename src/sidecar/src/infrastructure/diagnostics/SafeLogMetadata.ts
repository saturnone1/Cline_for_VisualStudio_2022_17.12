const MAX_LOG_METADATA_CHARS = 8_000

export function formatLogMetadata(metadata: unknown) {
	if (metadata === undefined) return ""
	const seen = new WeakSet<object>()
	let serialized: string
	try {
		serialized = JSON.stringify(metadata, (_key, value) => {
			if (!value || typeof value !== "object") return value
			if (seen.has(value)) return "[Circular]"
			seen.add(value)
			return value
		}) ?? String(metadata)
	} catch {
		serialized = String(metadata)
	}
	return serialized.length <= MAX_LOG_METADATA_CHARS
		? serialized
		: `${serialized.slice(0, MAX_LOG_METADATA_CHARS)}...[truncated ${serialized.length - MAX_LOG_METADATA_CHARS} chars]`
}
