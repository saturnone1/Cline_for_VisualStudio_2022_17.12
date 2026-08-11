import { CHAT_MESSAGE_RENDERER_TYPES } from "./ChatMessageRendererRegistry"

describe("ChatMessageRendererRegistry", () => {
	it("registers every top-level chat message type", () => {
		expect([...CHAT_MESSAGE_RENDERER_TYPES].sort()).toEqual(["ask", "say"])
	})
})
