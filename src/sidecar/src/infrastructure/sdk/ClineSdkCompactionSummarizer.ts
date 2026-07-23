import type { ApiHandler, Message, ProviderConfig } from "@cline/llms"
import { chunkTextByTokenBudget, estimateTextTokens } from "../../domain/context/TokenEstimator"

const DEFAULT_TIMEOUT_MS = 180_000
const MAX_SUMMARY_OUTPUT_TOKENS = 2_048

export async function summarizeCompactionContext(
	config: Readonly<Record<string, unknown>>,
	initialMessages: readonly unknown[],
	externalSignal?: AbortSignal,
) {
	const source = serializeMessages(initialMessages)
	if (!source.trim()) throw new Error("No conversation context was available to summarize.")

	const providerId = stringValue(config.providerId)
	const modelId = stringValue(config.modelId)
	if (!providerId || !modelId) throw new Error("Context compaction requires a configured provider and model.")

	const nested = asRecord(config.providerConfig)
	const budget = resolveCompactionBudget(config)
	const handlerConfig = {
		...nested,
		...config,
		providerId,
		modelId,
		maxOutputTokens: budget.outputTokens,
		thinking: false,
	} as ProviderConfig
	const { createHandlerAsync } = await importEsmModule<typeof import("@cline/llms")>("@cline/llms")
	const handler = await createHandlerAsync(handlerConfig)
	const abortController = new AbortController()
	const abortFromCaller = () => abortController.abort()
	if (externalSignal?.aborted) abortController.abort()
	else externalSignal?.addEventListener("abort", abortFromCaller, { once: true })
	const timeoutMs = boundedTimeout(config.apiTimeoutMs)
	const timeout = setTimeout(() => abortController.abort(), timeoutMs)
	handler.setAbortSignal?.(abortController.signal)

	try {
		const inputLimit = budget.inputTokens
		let summaries: string[] = []
		const sourceChunks = chunkTextByTokenBudget(source, inputLimit)
		for (let index = 0; index < sourceChunks.length; index++) {
			summaries.push(await requestSummary(handler, buildSummaryPrompt(sourceChunks[index], index + 1, sourceChunks.length)))
		}
		const maximumMergeRounds = Math.ceil(Math.log2(Math.max(1, sourceChunks.length))) + 2
		let mergeRound = 0
		while (summaries.length > 1) {
			if (mergeRound++ >= maximumMergeRounds) throw new Error("Context compaction summaries did not converge.")
			const previousCount = summaries.length
			const groups = chunkTextByTokenBudget(summaries.join("\n\n--- NEXT PART ---\n\n"), inputLimit)
			if (groups.length === 1) return requestSummary(handler, buildMergePrompt(groups[0]))
			const merged: string[] = []
			for (const group of groups) merged.push(await requestSummary(handler, buildMergePrompt(group)))
			assertCompactionConvergence(previousCount, merged.length)
			summaries = merged
		}
		return summaries[0]
	} catch (error) {
		if (externalSignal?.aborted) throw new Error("Context compaction was cancelled.")
		if (abortController.signal.aborted) throw new Error(`Context compaction timed out after ${timeoutMs}ms.`)
		throw error
	} finally {
		clearTimeout(timeout)
		externalSignal?.removeEventListener("abort", abortFromCaller)
		handler.setAbortSignal?.(undefined)
	}
}

export function assertCompactionConvergence(previousCount: number, nextCount: number) {
	if (nextCount >= previousCount) throw new Error(`Context compaction summaries did not converge (${previousCount} -> ${nextCount}).`)
}

export function estimateCompactedTokens(messages: readonly unknown[]) {
	return Math.max(1, estimateTextTokens(serializeMessages(messages)))
}

async function requestSummary(handler: ApiHandler, prompt: string) {
	let summary = ""
	const messages: Message[] = [{ role: "user", content: prompt }]
	for await (const chunk of handler.createMessage(
		"You summarize an ongoing software-engineering conversation for another AI agent. Do not use tools. Return only a durable continuation summary.",
		messages,
	)) {
		if (chunk.type === "text") summary += chunk.text
		if (chunk.type === "done" && !chunk.success) throw new Error(chunk.error || "The compaction model did not complete successfully.")
	}
	const normalized = summary.trim()
	if (normalized.length < 80) throw new Error(`The compaction model returned an incomplete summary (${normalized.length} characters).`)
	return normalized
}

function buildSummaryPrompt(source: string, part: number, totalParts: number) {
	return [
		"Summarize the conversation below so a replacement agent session can continue without access to the original transcript.",
		totalParts > 1 ? `This is chronological part ${part} of ${totalParts}. Preserve details needed to merge it with the other parts.` : "",
		"Preserve the user's goals and decisions, completed changes, exact file paths and identifiers, important tool results and errors, current runtime state, unresolved work, and constraints.",
		"Distinguish explicit user requests from assistant interpretations. Do not promote an assistant assumption into a user goal unless the user's own text supports it; preserve ambiguous requests verbatim and label them as ambiguous.",
		"Do not claim work that was not completed. Use concise headings and concrete bullet points. Do not answer the user or invoke tools.",
		"",
		"<conversation>",
		source,
		"</conversation>",
	].join("\n")
}

function buildMergePrompt(source: string) {
	return [
		"Merge the chronological partial summaries below into one durable continuation summary.",
		"Preserve goals, decisions, completed changes, exact identifiers, unresolved work, constraints, and the order in which state changed.",
		"Do not discard an older fact unless a later summary explicitly supersedes it. Do not answer the user or invoke tools.",
		"",
		"<partial_summaries>",
		source,
		"</partial_summaries>",
	].join("\n")
}

export function resolveCompactionBudget(config: Readonly<Record<string, unknown>>) {
	const nested = asRecord(config.providerConfig)
	const modelInfo = asRecord(config.modelInfo)
	const nestedModelInfo = asRecord(nested.modelInfo)
	const candidates = [config.contextWindow, config.contextWindowTokens, config.maxInputTokens, nested.contextWindow, nested.contextWindowTokens, nested.maxInputTokens, modelInfo.contextWindow, modelInfo.context_length, nestedModelInfo.contextWindow, nestedModelInfo.context_length]
	const contextTokens = candidates.map(positiveNumber).find((value) => value !== undefined) ?? 32_000
	const outputTokens = Math.min(MAX_SUMMARY_OUTPUT_TOKENS, Math.max(256, Math.floor(contextTokens * 0.2)))
	const promptReserveTokens = Math.max(512, Math.floor(contextTokens * 0.15))
	const usableTokens = Math.max(256, contextTokens - outputTokens - promptReserveTokens)
	return { contextTokens, outputTokens, inputTokens: Math.min(120_000, usableTokens) }
}

function positiveNumber(value: unknown) {
	const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function serializeMessages(messages: readonly unknown[]) {
	return messages.map((message) => {
		const record = asRecord(message)
		const role = stringValue(record.role)
		return role === "context"
			? `<previous_compacted_context>\n${messageContent(record)}\n</previous_compacted_context>`
			: `${role || "unknown"}: ${messageContent(record)}`
	}).filter((line) => line.trim().length > 0).join("\n\n")
}

function messageContent(value: unknown) {
	const content = asRecord(value).content
	if (typeof content === "string") return content
	try { return JSON.stringify(content ?? "") } catch { return String(content ?? "") }
}

function boundedTimeout(value: unknown) {
	const configured = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_TIMEOUT_MS
	return Math.max(30_000, Math.min(configured, DEFAULT_TIMEOUT_MS))
}

// The sidecar is emitted as CommonJS while the bundled Cline packages expose
// ESM-only entry points. Preserve native dynamic import at this boundary.
const importEsm = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>
function importEsmModule<T>(specifier: string) { return importEsm(specifier) as Promise<T> }

function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function stringValue(value: unknown) { return typeof value === "string" ? value.trim() : "" }
