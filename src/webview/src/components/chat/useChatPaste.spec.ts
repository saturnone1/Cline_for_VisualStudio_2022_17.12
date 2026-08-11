import { insertPastedUrl } from "./useChatPaste"

describe("insertPastedUrl", () => {
	it("inserts a normalized URL at the cursor and appends a removable space", () => {
		expect(insertPastedUrl("before after", 7, "  https://example.com/path  ")).toEqual({
			value: "before https://example.com/path after",
			cursorPosition: 32,
		})
	})
})
