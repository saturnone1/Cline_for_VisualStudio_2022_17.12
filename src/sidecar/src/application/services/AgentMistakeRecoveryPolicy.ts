export type AgentMistakeContext = Readonly<{
	iteration: number
	consecutiveMistakes: number
	maxConsecutiveMistakes: number
	reason: "api_error" | "invalid_tool_call" | "tool_execution_failed"
	details?: string
}>

export type AgentMistakeDecision = Readonly<{ action: "continue"; guidance?: string } | { action: "stop"; reason?: string }>

export function createAgentMistakeRecoveryPolicy(log: (event: string, details: Record<string, unknown>) => void) {
	const recoveryAttempts = new Map<string, number>()
	return (context: AgentMistakeContext): AgentMistakeDecision => {
		const key = failureKey(context)
		const attempt = (recoveryAttempts.get(key) || 0) + 1
		recoveryAttempts.set(key, attempt)
		log("agentMistakeRecoveryRequested", { ...context, recoveryKey: key, recoveryAttempt: attempt })
		return {
			action: "continue",
			guidance: buildRecoveryGuidance(context, attempt),
		}
	}
}

function failureKey(context: AgentMistakeContext) {
	const repeatedTool = context.details?.match(/identical calls to `([^`]+)`/i)?.[1]
	return repeatedTool ? `${context.reason}:repeated-tool:${repeatedTool}` : `${context.reason}:${context.details?.trim() || "unspecified"}`
}

function buildRecoveryGuidance(context: AgentMistakeContext, attempt: number) {
	const details = context.details?.trim() || `Repeated ${context.reason.replace(/_/g, " ")}.`
	return [
		`The previous approach did not make progress: ${details}`,
		"Do not repeat the same tool call with the same input.",
		attempt > 1
			? "This recovery has already been attempted. Stop using tools for this approach and explain the blocker to the user, or choose a materially different approach."
			: "Treat the latest tool result or error as evidence and respond to the user with the current status, explain what prevented progress, or choose a materially different tool or input.",
	].join(" ")
}
