import { nextMenuIndex, slashQueryAtCursor } from "./useSlashCommandMenu"

describe("slash command menu state", () => {
	it("derives the query nearest to the cursor", () => {
		expect(slashQueryAtCursor("prefix /workflow trailing", 16)).toBe("workflow")
	})

	it("wraps keyboard selection in both directions", () => {
		expect(nextMenuIndex(2, 1, 3)).toBe(0)
		expect(nextMenuIndex(0, -1, 3)).toBe(2)
		expect(nextMenuIndex(4, 1, 0)).toBe(4)
	})
})
