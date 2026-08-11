export function getString(value: unknown, key: string): string {
	if (!value || typeof value !== "object" || !(key in value)) return ""
	const field = (value as Record<string, unknown>)[key]
	return typeof field === "string" ? field : ""
}

export function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function sdkStatusToTaskLifecycle(status: string) {
	const normalized = status.trim().toLowerCase()
	if (["running", "pending", "starting", "queued"].includes(normalized)) return "streaming" as const
	if (["idle", "completed", "complete", "ended", "stopped", "cancelled"].includes(normalized)) return "completed" as const
	if (["failed", "error"].includes(normalized)) return "failed" as const
	return null
}

export { readPositiveIntEnv }
import { readPositiveIntEnv } from "../configuration/RuntimeEnvironment"
