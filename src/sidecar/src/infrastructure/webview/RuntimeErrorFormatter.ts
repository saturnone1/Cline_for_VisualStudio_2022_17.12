export function isSessionNotFoundError(error: unknown) {
	const message = error instanceof Error ? error.message : String(error)
	return /session not found/i.test(message)
}

export function stringify(value: unknown): string {
	if (typeof value === "string") return value
	if (value instanceof Error) {
		const details = [value.name, value.message].filter(Boolean).join(": ")
		const cause = (value as Error & { cause?: unknown }).cause
		return cause === undefined ? details : `${details}\nCaused by: ${stringify(cause)}`
	}
	try {
		const serialized = JSON.stringify(value)
		return serialized === undefined || serialized === "{}" ? String(value) : serialized
	} catch {
		return String(value)
	}
}

export function formatEmptyModelResponseForUi(language: "en" | "ko") {
	return language === "ko"
		? "모델이 응답 본문을 생성하지 못했습니다. 선택한 모델이 Ollama에서 정상적으로 실행되는지 확인하거나 다른 모델로 다시 시도해 주세요."
		: "The model returned no response body. Verify that the selected model runs correctly in Ollama, or retry with another model."
}

export function formatProviderErrorForTranscript(value: unknown, language: "en" | "ko") {
	const text = stringify(value).trim()
	if (!text) return language === "ko" ? "모델 제공자가 빈 오류를 반환했습니다." : "The model provider returned an empty error."
	if (/too many requests|rate limit|429/i.test(text)) {
		return language === "ko" ? `모델 제공자 응답: 요청 한도를 초과했습니다.\n\n${text}` : `Model provider response: rate limit exceeded.\n\n${text}`
	}
	return text
}

export function formatRunRetryNoticeForUi(attempt: number, maxAttempts: number, language: "en" | "ko") {
	return language === "ko"
		? `모델 요청이 응답 전에 실패했습니다. 오류 내용을 에이전트에 전달하고 이어서 진행합니다. (재시도 ${attempt}/${maxAttempts})`
		: `The model request failed before a response arrived. Reporting the error to the agent and continuing. (retry ${attempt} of ${maxAttempts})`
}

export function formatSdkErrorForUi(error: unknown, language: "en" | "ko") {
	const text = stringify(error).trim()
	if (text && text !== "[object Object]" && text !== "{}") return text
	return language === "en"
		? "The SDK request ended before a final response could be synchronized."
		: "SDK 요청이 최종 응답을 동기화하기 전에 종료되었습니다."
}
