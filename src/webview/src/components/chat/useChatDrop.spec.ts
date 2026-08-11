import { parseDroppedUris } from "./useChatDrop"
import { vi } from "vitest"

describe("parseDroppedUris", () => {
	it("decodes and filters multi-selection resource URLs", () => {
		expect(
			parseDroppedUris(
				JSON.stringify(["file:///C:/Project/My%20File.cs", "https://example.com/ignored", "vscode-remote://ssh/repo/a.ts"]),
				"",
			),
		).toEqual(["file:///C:/Project/My File.cs", "vscode-remote://ssh/repo/a.ts"])
	})

	it("falls back to the URI list when resource URLs are invalid", () => {
		vi.spyOn(console, "error").mockImplementationOnce(() => undefined)
		expect(parseDroppedUris("not-json", "vscode-file:///C:/repo/a.cs\nfile:///C:/repo/b.cs\ninvalid")).toEqual([
			"vscode-file:///C:/repo/a.cs",
			"file:///C:/repo/b.cs",
		])
	})
})
