import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import NewTaskButton from "./NewTaskButton"

describe("NewTaskButton", () => {
	it("renders one accessible button and forwards the click", () => {
		const onClick = vi.fn()
		const { container } = render(<NewTaskButton onClick={onClick} />)

		expect(container.querySelectorAll("button")).toHaveLength(1)
		fireEvent.click(screen.getByRole("button", { name: "작업 목록으로" }))
		expect(onClick).toHaveBeenCalledTimes(1)
	})
})
