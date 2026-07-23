import type { AskQuestionResult } from "../../application/ports/AgentInteraction"
import type { AgentToolContext } from "@cline/shared"

export const BUILTIN_TOOL_REPLACEMENT_MARKER = "__ligVsReplacesBuiltinTool"

export function createAskQuestionAgentTool(
	onAskQuestion?: (question: string, options: string[], signal?: AbortSignal) => Promise<AskQuestionResult>,
) {
	if (!onAskQuestion) return undefined

	return {
		name: "ask_question",
		description: "Ask the user one clarifying question and provide one or more selectable options. Include every distinct option needed for the decision.",
		inputSchema: {
			type: "object",
			properties: {
				question: { type: "string", minLength: 1 },
				options: {
					type: "array",
					items: { type: "string", minLength: 1 },
					minItems: 1,
					uniqueItems: true,
				},
			},
			required: ["question", "options"],
			additionalProperties: false,
		},
		[BUILTIN_TOOL_REPLACEMENT_MARKER]: "ask_question",
		execute: async (input: unknown, context?: AgentToolContext) => {
			const record = asRecord(input)
			const question = readNonEmptyString(record.question)
			const options = readStringArray(record.options)
			if (!question) throw new Error("A non-empty question is required.")
			if (options.length === 0) throw new Error("At least one non-empty option is required.")
			const signal = context?.signal ?? (context as AgentToolContext & { abortSignal?: AbortSignal } | undefined)?.abortSignal
			if (signal?.aborted) throw abortError()
			return onAskQuestion(question, options, signal)
		},
	}
}

function abortError() {
	const error = new Error("Question was cancelled.")
	error.name = "AbortError"
	return error
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function readNonEmptyString(value: unknown) {
	return typeof value === "string" && value.trim() ? value.trim() : ""
}

function readStringArray(value: unknown) {
	if (!Array.isArray(value)) return []
	return [...new Set(value.map(readNonEmptyString).filter(Boolean))]
}
