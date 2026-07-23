export function throwIfOperationCancelled(signal?: AbortSignal) {
	if (!signal?.aborted) return
	if (signal.reason instanceof Error) throw signal.reason
	const error = new Error("Operation was cancelled.")
	error.name = "AbortError"
	throw error
}
