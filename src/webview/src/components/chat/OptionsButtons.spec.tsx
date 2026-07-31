import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { TaskServiceClient } from "@/services/grpcClient"
import { OptionsButtons } from "./OptionsButtons"

vi.mock("@/services/grpcClient", () => ({
	TaskServiceClient: { askResponse: vi.fn() },
}))

describe("OptionsButtons", () => {
	beforeEach(() => vi.clearAllMocks())

	it("submits only one answer while the selected response is in flight", async () => {
		let completeRequest!: () => void
		vi.mocked(TaskServiceClient.askResponse).mockReturnValue(new Promise<void>((resolve) => { completeRequest = resolve }))
		render(<OptionsButtons isActive options={["첫 번째", "두 번째"]} />)

		fireEvent.click(screen.getByRole("button", { name: "첫 번째" }))
		fireEvent.click(screen.getByRole("button", { name: "두 번째" }))

		expect(TaskServiceClient.askResponse).toHaveBeenCalledTimes(1)
		expect(screen.getByRole("button", { name: "두 번째" })).toBeDisabled()
		const request = vi.mocked(TaskServiceClient.askResponse).mock.calls[0][0]
		expect(request.text).toBe("첫 번째")
		expect(request.clientOperationId).toBeTruthy()

		completeRequest()
		await waitFor(() => expect(screen.getByRole("button", { name: "두 번째" })).not.toBeDisabled())
	})
})
