import type { ScheduledAgentSpecInput } from "../../application/ports/ScheduledAgentStorePort"

export function getScheduledSpecId(request: ScheduledAgentSpecInput) {
	return safeFileStem(readString(request.id) || readString(request.specId) || readString(request.name) || readString(request.fileName))
}

export function buildScheduledAgentSpec(existing: Record<string, unknown>, request: ScheduledAgentSpecInput, specId: string, updatedAt: string) {
	return {
		...existing,
		id: safeFileStem(specId || "scheduled-agent"),
		name: readString(request.name) || readString(existing.name) || specId,
		description: readString(request.description) || readString(existing.description),
		schedule: readString(request.schedule) || readString(request.cron) || readString(existing.schedule),
		prompt: readString(request.prompt) || readString(request.task) || readString(request.text) || readString(existing.prompt),
		enabled: request.enabled === undefined ? existing.enabled !== false : request.enabled !== false,
		updatedAt,
	}
}

export function prependScheduledRun(runs: readonly Record<string, unknown>[], run: Record<string, unknown>, runId: string) {
	return [{ runId, ...run }, ...runs].slice(0, 25)
}

export function parseLooseKeyValueSpec(text: string) {
	const result: Record<string, unknown> = {}
	const frontMatter = text.match(/^---\s*[\r\n]+([\s\S]*?)[\r\n]+---/)
	for (const line of (frontMatter?.[1] || text).split(/\r?\n/)) {
		const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/)
		if (match) result[match[1]] = match[2].replace(/^["']|["']$/g, "")
	}
	return result
}

export function markdownBodyAfterFrontMatter(text: string) { return text.replace(/^---\s*[\r\n]+[\s\S]*?[\r\n]+---\s*/, "").trim() }
export function safeFileStem(value: string) { return String(value || "").trim().replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) }
function readString(value: unknown) { return typeof value === "string" ? value : value == null ? "" : String(value) }
