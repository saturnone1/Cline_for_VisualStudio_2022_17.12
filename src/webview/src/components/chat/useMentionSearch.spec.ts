import { parseMentionSearchQuery } from "./useMentionSearch"

describe("parseMentionSearchQuery", () => {
	it("separates a workspace prefix from the file query", () => {
		expect(parseMentionSearchQuery("frontend:/components/Button")).toEqual({
			workspaceHint: "frontend",
			query: "components/Button",
		})
	})

	it("preserves ordinary search text", () => {
		expect(parseMentionSearchQuery("src/agent")).toEqual({ query: "src/agent" })
	})
})
