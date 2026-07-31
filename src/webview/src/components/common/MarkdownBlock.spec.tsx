import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import MarkdownBlock from "./MarkdownBlock"

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ mode: "act" }),
}))

describe("MarkdownBlock", () => {
	it("renders GFM tables instead of rejecting the table node", () => {
		render(
			<MarkdownBlock markdown={"| 기능 | 상태 |\n| --- | --- |\n| 압축 | 완료 |"} />,
		)

		expect(screen.getByRole("table")).toBeTruthy()
		expect(screen.getByRole("columnheader", { name: "기능" })).toBeTruthy()
		expect(screen.getByRole("cell", { name: "완료" })).toBeTruthy()
	})
})
