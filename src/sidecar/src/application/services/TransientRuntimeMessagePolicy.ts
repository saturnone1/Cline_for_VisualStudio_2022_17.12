const LEGACY_TRANSIENT_RUNTIME_NOTICES = new Set([
	"auto-compacting",
	"auto-compacted",
	"auto-compaction-skipped",
	"compaction-budget-adjusted",
])

// Older builds persisted SDK machine-status notices as assistant chat rows.
// Match only the exact legacy payload so ordinary conversation remains intact.
export function isLegacyTransientRuntimeMessage(message: Record<string, unknown>) {
	if (stringValue(message.type) !== "say" || stringValue(message.say) !== "text" || stringValue(message.ask)) {
		return false
	}
	if (!LEGACY_TRANSIENT_RUNTIME_NOTICES.has(stringValue(message.text).trim().toLowerCase())) {
		return false
	}
	const images = Array.isArray(message.images) ? message.images : []
	const files = Array.isArray(message.files) ? message.files : []
	return images.length === 0 && files.length === 0 && !stringValue(message.reasoning)
}

function stringValue(value: unknown) {
	return typeof value === "string" ? value : value == null ? "" : String(value)
}
