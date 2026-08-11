export type RuntimeErrorClass = "transient" | "fatal"

export type RuntimeErrorRecoveryDecision = Readonly<
	| { action: "retry"; attempt: number; maxAttempts: number; guidance: string }
	| { action: "surface"; reason: "fatal" | "attempts-exhausted" | "disabled" }
>

// A run can die before the model ever sees the failure: the provider returns a
// body the SDK schema rejects, the socket drops, or the endpoint answers 5xx.
// Those say nothing about the task, so the agent gets told what happened and
// keeps going instead of the whole task ending in the sidecar.
const TRANSIENT_PATTERNS: readonly RegExp[] = [
	/type validation failed/i,
	/zoderror/i,
	/invalid input/i,
	/unexpected error/i,
	/failed to parse|could not parse|json parse/i,
	/premature close|socket hang up|aborted by the (server|peer)/i,
	/fetch failed|network error|econnreset|econnrefused|etimedout|epipe|enetunreach|eai_again|enotfound/i,
	/timeout|timed out/i,
	/\b(408|409|425|429|500|502|503|504|529)\b/,
	/rate limit|too many requests|overloaded|service unavailable|bad gateway|gateway timeout/i,
]

// Retrying these only burns tokens: the next attempt fails identically until a
// human changes configuration, or the user themselves stopped the run.
const FATAL_PATTERNS: readonly RegExp[] = [
	/\b(400|401|403|404)\b/,
	/unauthorized|forbidden|invalid api key|authentication|permission denied/i,
	/context length|context window|maximum context|too many tokens|prompt is too long/i,
	/model .{0,40}(not found|does not exist)|unknown model|no such model/i,
	/\bAbortError\b/,
	/user (aborted|cancelled|canceled)|operation was (aborted|cancelled|canceled)|task cancellation/i,
	/runtime is not attached/i,
]

export function classifyRuntimeError(error: unknown): RuntimeErrorClass {
	const text = describeRuntimeError(error)
	if (!text) return "fatal"
	if (FATAL_PATTERNS.some((pattern) => pattern.test(text))) return "fatal"
	// Anything unrecognized keeps the historical behaviour of surfacing to the
	// user, so a new failure mode can never turn into a silent retry loop.
	return TRANSIENT_PATTERNS.some((pattern) => pattern.test(text)) ? "transient" : "fatal"
}

export function createRuntimeErrorRecoveryPolicy(options: {
	maxAttempts: () => number
	log: (event: string, details: Record<string, unknown>) => void
}) {
	const attempts = new Map<string, number>()
	return {
		decide(sessionId: string, error: unknown): RuntimeErrorRecoveryDecision {
			const classification = classifyRuntimeError(error)
			const maxAttempts = Math.max(0, Math.trunc(options.maxAttempts()))
			const attempt = (attempts.get(sessionId) || 0) + 1
			if (classification === "fatal") {
				options.log("runtimeErrorRecoverySurfaced", { sessionId, reason: "fatal", error: describeRuntimeError(error) })
				return { action: "surface", reason: "fatal" }
			}
			if (maxAttempts <= 0) {
				options.log("runtimeErrorRecoverySurfaced", { sessionId, reason: "disabled", error: describeRuntimeError(error) })
				return { action: "surface", reason: "disabled" }
			}
			if (attempt > maxAttempts) {
				options.log("runtimeErrorRecoverySurfaced", { sessionId, reason: "attempts-exhausted", attempt, maxAttempts, error: describeRuntimeError(error) })
				return { action: "surface", reason: "attempts-exhausted" }
			}
			attempts.set(sessionId, attempt)
			options.log("runtimeErrorRecoveryRetryDecided", { sessionId, attempt, maxAttempts, error: describeRuntimeError(error) })
			return { action: "retry", attempt, maxAttempts, guidance: buildRetryGuidance(error, attempt, maxAttempts) }
		},
		// A run that produced a result proves the provider is reachable again, so
		// the budget resets and a later unrelated blip still gets its retries.
		noteRunSucceeded(sessionId: string) {
			attempts.delete(sessionId)
		},
	}
}

export function describeRuntimeError(error: unknown): string {
	if (typeof error === "string") return error
	if (error instanceof Error) {
		const cause = (error as Error & { cause?: unknown }).cause
		const details = [error.name, error.message].filter(Boolean).join(": ")
		return cause === undefined ? details : `${details}\nCaused by: ${describeRuntimeError(cause)}`
	}
	try {
		const serialized = JSON.stringify(error)
		return serialized === undefined || serialized === "{}" ? String(error) : serialized
	} catch {
		return String(error)
	}
}

function buildRetryGuidance(error: unknown, attempt: number, maxAttempts: number) {
	return [
		`The previous model request failed before any response was produced: ${describeRuntimeError(error).trim()}`,
		"This is a provider or transport failure, not a mistake in your own reasoning, and no tool result was lost.",
		`This is retry ${attempt} of ${maxAttempts}. Continue the task from where it stopped.`,
		"If the identical failure repeats, stop calling tools and report the blocker to the user instead of retrying again.",
	].join(" ")
}
