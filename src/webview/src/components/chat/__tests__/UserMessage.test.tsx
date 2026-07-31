import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import UserMessage from "../UserMessage"

describe("UserMessage", () => {
	it("renders user content in a right-aligned, non-editable message bubble", () => {
		render(<UserMessage images={[]} text="사용자 질문" />)

		const message = screen.getByTestId("user-message")
		expect(message.className).toContain("lig-user-message")

		fireEvent.click(screen.getByText("사용자 질문"))

		expect(screen.queryByRole("textbox")).toBeNull()
		expect(screen.queryByText("Restore Chat")).toBeNull()
		expect(screen.queryByText("Restore All")).toBeNull()
	})

	it("renders attached images and files as message content", () => {
		render(
			<UserMessage
				files={["C:\\workspace\\README.md"]}
				images={["data:image/png;base64,AAAA"]}
				text="첨부 검토"
			/>,
		)

		expect(screen.getByAltText("Thumbnail image-1")).toBeTruthy()
		expect(screen.getByTitle("README.md")).toBeTruthy()
		expect(screen.queryByText(/Attachments:/)).toBeNull()
	})
})
