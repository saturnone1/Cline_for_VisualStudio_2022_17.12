const wrappedTools = new WeakSet<object>()

type FailureCallback = (message: string, error: unknown) => void
type SuccessCallback = () => void

export function wrapAgentToolFailureContext(
	tool: Record<string, unknown>,
	toolLabel: string,
	onFailure: FailureCallback = () => undefined,
	onSuccess: SuccessCallback = () => undefined,
) {
	if (wrappedTools.has(tool) || typeof tool.execute !== "function") return tool
	const execute = tool.execute
	const wrapped = {
		...tool,
		execute: async (...args: unknown[]) => {
			try {
				const result = await Reflect.apply(execute, tool, args)
				onSuccess()
				return result
			} catch (error) {
				if (isCancellation(error)) throw error
				const message = formatAgentToolFailure(toolLabel, error)
				onFailure(message, error)
				throw new Error(message)
			}
		},
	}
	wrappedTools.add(wrapped)
	return wrapped
}

export function wrapAgentToolExecutorMap<T extends Record<string, unknown>>(
	executors: T,
	onFailure: (toolName: string, message: string, error: unknown) => void = () => undefined,
): T {
	return Object.fromEntries(Object.entries(executors).map(([toolName, executor]) => {
		if (typeof executor !== "function") return [toolName, executor]
		return [toolName, async (...args: unknown[]) => {
			try {
				return await Reflect.apply(executor, executors, args)
			} catch (error) {
				if (isCancellation(error)) throw error
				const message = formatAgentToolFailure(toolName, error)
				onFailure(toolName, message, error)
				throw new Error(message)
			}
		}]
	})) as T
}

export function formatAgentToolFailure(toolLabel: string, error: unknown) {
	return `Tool "${toolLabel || "unknown"}" failed: ${describeError(error)}`
}

function describeError(error: unknown): string {
	if (error instanceof Error && error.message.trim()) return error.message.trim()
	if (typeof error === "string" && error.trim()) return error.trim()
	if (error && typeof error === "object") {
		const record = error as Record<string, unknown>
		for (const value of [record.message, record.error, record.reason, record.detail]) {
			if (typeof value === "string" && value.trim()) return value.trim()
			if (value instanceof Error && value.message.trim()) return value.message.trim()
		}
		try {
			const serialized = JSON.stringify(error)
			if (serialized && serialized !== "{}") return serialized
		} catch { /* Fall through to the stable fallback. */ }
	}
	return "The tool returned an unknown error."
}

function isCancellation(error: unknown) {
	return error instanceof Error && (error.name === "AbortError" || /\bcancel(?:led|ed|ation)?\b/i.test(error.message))
}
