import type { ClineMessage } from "@shared/ExtensionMessage"

type UiLanguage = "en" | "ko"

function getMessageLabel(message: ClineMessage, language: UiLanguage): string {
	const korean = language === "ko"
	if (message.say === "task" || message.say === "user_feedback" || message.say === "user_feedback_diff") {
		return korean ? "사용자" : "User"
	}
	if (message.say === "text" || message.say === "completion_result") {
		return "LIG VS"
	}
	if (message.say === "reasoning" || message.say === "api_req_started") {
		return korean ? "모델 내부 추론" : "Model reasoning"
	}
	if (message.type === "ask") {
		return korean ? "LIG VS 요청" : "LIG VS request"
	}
	return korean ? "시스템/도구" : "System/tool"
}

function getMessageContent(message: ClineMessage, language: UiLanguage): string {
	const parts: string[] = []
	const text = message.text?.trim()
	const reasoning = message.reasoning?.trim()
	if (text) parts.push(text)
	if (reasoning && reasoning !== text) parts.push(reasoning)
	if (message.files?.length) parts.push(`${language === "ko" ? "파일" : "Files"}:\n${message.files.map((file) => `- ${file}`).join("\n")}`)
	if (message.images?.length) parts.push(`${language === "ko" ? "이미지" : "Images"}:\n${message.images.map((image, index) => `- ${formatImageReference(image, index, language)}`).join("\n")}`)
	return parts.join("\n\n")
}

function formatImageReference(image: string, index: number, language: UiLanguage) {
	if (!image.startsWith("data:")) return image
	const match = /^data:([^;,]+)/i.exec(image)
	const type = match?.[1] || "image"
	const approximateBytes = Math.max(0, Math.floor((image.length - image.indexOf(",") - 1) * 0.75))
	const size = approximateBytes >= 1_048_576
		? `${(approximateBytes / 1_048_576).toFixed(1)} MB`
		: `${Math.max(1, Math.ceil(approximateBytes / 1024))} KB`
	return language === "ko" ? `첨부 이미지 ${index + 1} (${type}, ${size})` : `Attached image ${index + 1} (${type}, ${size})`
}

export function formatTaskTranscript(messages: ClineMessage[], language: UiLanguage): string {
	return messages
		.map((message) => {
			const content = getMessageContent(message, language)
			return content ? `${getMessageLabel(message, language)}:\n${content}` : ""
		})
		.filter(Boolean)
		.join("\n\n")
}
