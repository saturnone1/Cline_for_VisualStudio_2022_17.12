const USER_INPUT_ENVELOPE = /^\s*<user_input\b[^>]*>([\s\S]*?)<\/user_input>\s*$/i

export function unwrapSdkUserInputEnvelope(value: string) {
	const match = USER_INPUT_ENVELOPE.exec(value)
	return match ? match[1] : value
}

export function extractSdkUserInput(value: string) {
	const unwrapped = unwrapSdkUserInputEnvelope(value)
	return unwrapped === value ? "" : unwrapped
}
