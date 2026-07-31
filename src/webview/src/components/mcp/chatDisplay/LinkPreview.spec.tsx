import { render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { WebServiceClient } from "@/services/grpcClient"
import LinkPreview from "./LinkPreview"

vi.mock("@/services/grpcClient", () => ({
	WebServiceClient: {
		fetchOpenGraphData: vi.fn(),
		openInBrowser: vi.fn(),
	},
}))

describe("LinkPreview", () => {
	beforeEach(() => vi.clearAllMocks())

	it("fetches a URL once and keeps the completed preview stable", async () => {
		vi.mocked(WebServiceClient.fetchOpenGraphData).mockResolvedValue({
			title: "Example",
			description: "Description",
			siteName: "example.com",
		})
		const view = render(<LinkPreview url="https://example.com" />)
		expect(await screen.findByText("Example")).toBeInTheDocument()
		view.rerender(<LinkPreview url="https://example.com" />)
		expect(WebServiceClient.fetchOpenGraphData).toHaveBeenCalledTimes(1)
	})
})
