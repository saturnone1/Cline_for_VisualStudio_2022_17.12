import { act, fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { TaskServiceClient } from "@/services/grpcClient"
import CreditLimitError from "./CreditLimitError"

vi.mock("@/context/ClineAuthContext", () => ({ useClineAuth: () => ({ activeOrganization: undefined }) }))
vi.mock("@/services/grpcClient", () => ({
	AccountServiceClient: { getRedirectUrl: vi.fn(() => new Promise(() => undefined)) },
	TaskServiceClient: { askResponse: vi.fn() },
}))

describe("CreditLimitError", () => {
	beforeEach(() => vi.clearAllMocks())

	it("submits a single retry while the response is in flight", async () => {
		let completeRequest!: () => void
		vi.mocked(TaskServiceClient.askResponse)
			.mockReturnValueOnce(new Promise<void>((resolve) => { completeRequest = resolve }))
			.mockReturnValueOnce(new Promise<void>(() => undefined))
		render(<CreditLimitError currentBalance={0} message="No credits" />)
		const retry = screen.getByText("Retry Request").closest("vscode-button") as HTMLElement

		fireEvent.click(retry)
		fireEvent.click(retry)

		expect(TaskServiceClient.askResponse).toHaveBeenCalledTimes(1)
		expect(vi.mocked(TaskServiceClient.askResponse).mock.calls[0][0].clientOperationId).toBeTruthy()

		await act(async () => completeRequest())
		fireEvent.click(retry)
		expect(TaskServiceClient.askResponse).toHaveBeenCalledTimes(2)
	})
})
