import type { ClineMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { formatTaskTranscript } from "./taskTranscript"

describe("formatTaskTranscript", () => {
	it("copies the complete session in conversation order", () => {
		const messages = [
			{ ts: 1, type: "say", say: "task", text: "프로젝트를 검토해줘" },
			{ ts: 2, type: "say", say: "reasoning", text: "파일을 확인하겠습니다." },
			{ ts: 3, type: "say", say: "text", text: "검토가 끝났습니다." },
			{ ts: 4, type: "say", say: "user_feedback", text: "자세히 알려줘", files: ["Program.cs"] },
		] as ClineMessage[]

		expect(formatTaskTranscript(messages, "ko")).toBe(
			"사용자:\n프로젝트를 검토해줘\n\n모델 내부 추론:\n파일을 확인하겠습니다.\n\nLIG VS:\n검토가 끝났습니다.\n\n사용자:\n자세히 알려줘\n\n파일:\n- Program.cs",
		)
	})

	it("describes embedded images without copying their base64 payload", () => {
		const payload = `data:image/png;base64,${"A".repeat(4096)}`
		const transcript = formatTaskTranscript([
			{ ts: 1, type: "say", say: "task", text: "이미지 확인", images: [payload] },
		] as ClineMessage[], "ko")

		expect(transcript).toContain("첨부 이미지 1 (image/png")
		expect(transcript).not.toContain("AAAA")
	})
})
