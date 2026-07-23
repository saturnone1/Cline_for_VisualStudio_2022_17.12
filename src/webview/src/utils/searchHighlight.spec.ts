import { describe, expect, it } from "vitest"
import { escapeSearchResultText, highlightSearchResults } from "./searchHighlight"

describe("searchHighlight", () => {
	it("escapes untrusted text before adding highlight markup", () => {
		const [result] = highlightSearchResults([
			{
				item: { html: '<img src=x onerror="window.pwned=1">model' },
				refIndex: 0,
				matches: [{ key: "html", value: '<img src=x onerror="window.pwned=1">model', indices: [[38, 42]] }],
			},
		] as any)

		expect(result.html).not.toContain("<img")
		expect(result.html).toContain("&lt;img")
		expect(result.html).toContain('<span class="history-item-highlight">del</span>')
	})

	it("escapes model ids when no search highlight is required", () => {
		expect(escapeSearchResultText("<svg onload=alert(1)>")).toBe("&lt;svg onload=alert(1)&gt;")
	})
})
