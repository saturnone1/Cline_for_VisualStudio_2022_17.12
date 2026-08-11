import { describe, expect, it, vi } from "vitest"
import { convertHtmlToMarkdown, convertHtmlToMarkdownWithFallback } from "./markdownUtils"

describe("HTML to Markdown copy conversion", () => {
	it("serializes GFM tables", async () => {
		const markdown = await convertHtmlToMarkdown("<table><thead><tr><th>Name</th><th>State</th></tr></thead><tbody><tr><td>LIG VS</td><td>Ready</td></tr></tbody></table>")
		expect(markdown).toContain("| Name")
		expect(markdown).toContain("| LIG VS")
	})

	it("falls back to selected plain text when conversion fails", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const result = await convertHtmlToMarkdownWithFallback("<unknown />", "selected text", async () => { throw new Error("unsupported node") })
		expect(result).toBe("selected text")
		expect(warn).toHaveBeenCalledOnce()
		warn.mockRestore()
	})
})
