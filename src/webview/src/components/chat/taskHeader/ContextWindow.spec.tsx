import { render, screen } from "@testing-library/react"
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
		expect(screen.getByRole("button", { name: "Compact Task" })).toBeInTheDocument()
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

		expect(await screen.findByText("Compact the current task?")).toBeInTheDocument()
	})
})
