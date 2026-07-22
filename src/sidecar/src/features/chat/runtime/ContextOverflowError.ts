export function isContextOverflowError(error: unknown) {
	const text = errorText(error).toLowerCase()
	return [
		/context.{0,30}(length|window|limit).{0,40}(exceed|maximum|too (?:large|long)|overflow)/,
		/(exceed|maximum|too (?:large|long)|overflow).{0,40}context.{0,30}(length|window|limit)/,
		/(input|prompt).{0,20}tokens?.{0,30}(exceed|maximum|limit|too (?:large|long))/, 
		/max_tokens.{0,40}(at least 1|negative|less than)/,
		/token limit exceeded/,
	].some((pattern) => pattern.test(text))
}

function errorText(error: unknown): string {
	if (error instanceof Error) return `${error.name}: ${error.message}\n${error.stack || ""}`
	if (typeof error === "string") return error
	try { return JSON.stringify(error) } catch { return String(error) }
}
