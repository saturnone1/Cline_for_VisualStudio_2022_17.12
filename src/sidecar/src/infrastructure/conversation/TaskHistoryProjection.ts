import { normalizeUsageSnapshot } from "./UsageNormalization"
import { projectedTaskStorageBytes } from "../../features/taskHistory/TaskHistoryStorageSize"

export function createId() {
	return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

export function createHistoryItem(id: string, task: string, cwd: string, modelId: string) {
	return {
		id, ts: Date.now(), task,
		tokensIn: 0, tokensOut: 0, cacheWrites: 0, cacheReads: 0, totalCost: 0,
		isFavorited: false, size: 0, cwdOnTaskInitialization: cwd, modelId,
	}
}

export function sdkSessionToHistoryItem(session: Record<string, unknown>) {
	const metadata = asRecord(session.metadata)
	const usage = normalizeUsageSnapshot(metadata.aggregateUsage || metadata.usage || session.aggregateUsage || session.usage || asRecord(session.snapshot).aggregateUsage)
	const latestCheckpoint = asRecord(asRecord(metadata.checkpoint).latest)
	return {
		id: getString(session, "sessionId") || getString(session, "id") || createId(),
		ts: getNumber(session, "updatedAt") || getNumber(session, "createdAt") || Date.now(),
		task: stripLegacyMcpContext(getString(metadata, "title") || getString(session, "title") || getString(session, "prompt") || "LIG VS SDK task"),
		tokensIn: usage.inputTokens || 0,
		tokensOut: usage.outputTokens || 0,
		cacheWrites: usage.cacheWriteTokens || 0,
		cacheReads: usage.cacheReadTokens || 0,
		totalCost: getNumber(metadata, "totalCost") || usage.totalCost || 0,
		isFavorited: metadata.isFavorited === true,
		size: projectedTaskStorageBytes(session),
		cwdOnTaskInitialization: getString(session, "cwd") || getString(metadata, "cwd") || process.cwd(),
		modelId: getString(metadata, "modelId") || getString(session, "modelId") || "",
		latestCheckpointRunCount: getNumber(latestCheckpoint, "runCount"),
	}
}

export function removeDeletedHistoryItems(items: Array<Record<string, unknown>>, deletedTaskIds: Set<string>) {
	return deletedTaskIds.size === 0 ? items : items.filter((item) => !deletedTaskIds.has(String(item.id || "")))
}

function stripLegacyMcpContext(value: string) {
	return value.replace(/<lig-vs-mcp-context>[\s\S]*?<\/lig-vs-mcp-context>\s*/gi, "").trimStart()
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function getString(value: unknown, key: string) {
	const item = asRecord(value)[key]
	return typeof item === "string" ? item : item == null ? "" : String(item)
}

function getNumber(value: unknown, key: string) {
	const item = asRecord(value)[key]
	return typeof item === "number" && Number.isFinite(item) ? item : undefined
}
