import { isImageFile } from "./ToolMessageRenderer"

describe("ToolMessageRenderer", () => {
	it("classifies supported image paths case-insensitively", () => {
		expect(isImageFile("assets/Preview.PNG")).toBe(true)
		expect(isImageFile("src/agent.ts")).toBe(false)
		expect(isImageFile("README")).toBe(false)
	})
})
