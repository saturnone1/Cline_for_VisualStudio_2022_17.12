import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type React from "react"
import { describe, expect, it, vi } from "vitest"
import ContextWindow from "./ContextWindow"

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeButton: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
		<button type="button" {...props}>
			{children}
		</button>
	),
}))

describe("ContextWindow", () => {
	it("hides the context bar when usage is missing or placeholder zero", () => {
		render(<ContextWindow contextWindow={128000} lastApiReqTotalTokens={0} useAutoCondense={false} />)

		expect(screen.queryByLabelText("Context window usage progress")).not.toBeInTheDocument()
	})

	it("shows the context bar when reliable usage and context window are present", () => {
		render(<ContextWindow contextWindow={128000} lastApiReqTotalTokens={32000} useAutoCondense={false} />)

		expect(screen.getByLabelText("Context window usage progress")).toBeInTheDocument()
		expect(screen.getByRole("button", { name: "Compact conversation" })).toBeInTheDocument()
	})

	it("shows estimated usage when reported usage is unavailable", () => {
		render(
			<ContextWindow
				contextUsage={{ used: 64000, source: "estimated", reliable: false }}
				contextWindow={128000}
				useAutoCondense={false}
			/>,
		)

		expect(screen.getByLabelText("Context window usage progress")).toBeInTheDocument()
		expect(screen.getByText(/50.0%/)).toBeInTheDocument()
		expect(screen.getByText(/Estimated usage/)).toBeInTheDocument()
	})

	it("prompts for compaction once auto compact reaches the threshold", async () => {
		render(
			<ContextWindow
				contextUsage={{ used: 116000, source: "estimated", reliable: false }}
				contextWindow={128000}
				taskId="task-1"
				useAutoCondense
			/>,
		)

		expect(await screen.findByText("Compact the current conversation?")).toBeInTheDocument()
	})

	it("renders the compaction controls in Korean", async () => {
		render(
			<ContextWindow
				contextUsage={{ used: 116000, source: "estimated", reliable: false }}
				contextWindow={128000}
				language="ko"
				taskId="task-ko"
				useAutoCondense
			/>,
		)

		expect(screen.getByRole("button", { name: "대화 압축" })).toBeInTheDocument()
		expect(await screen.findByText("현재 대화를 압축할까요?")).toBeInTheDocument()
	})

	it("keeps the confirmation closed when compaction replaces the SDK session", async () => {
		const onCompact = vi.fn().mockResolvedValue(undefined)
		const view = render(
			<ContextWindow
				contextUsage={{ used: 116000, source: "estimated", reliable: false }}
				contextWindow={128000}
				onCompact={onCompact}
				taskId="source-session"
				useAutoCondense
			/>,
		)

		fireEvent.click(await screen.findByRole("button", { name: "Yes" }))
		await waitFor(() => expect(onCompact).toHaveBeenCalledTimes(1))
		expect(screen.queryByText("Compact the current conversation?")).not.toBeInTheDocument()

		view.rerender(
			<ContextWindow
				compactResetKey={123}
				contextUsage={{ used: 116000, source: "estimated", reliable: false }}
				contextWindow={128000}
				onCompact={onCompact}
				taskId="replacement-session"
				useAutoCondense
			/>,
		)

		await waitFor(() => expect(screen.queryByText("Compact the current conversation?")).not.toBeInTheDocument())
	})
})
