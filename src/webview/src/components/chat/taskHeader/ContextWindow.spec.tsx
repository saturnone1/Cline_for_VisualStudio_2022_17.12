import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import ContextWindow from "./ContextWindow"

describe("ContextWindow", () => {
	it("hides the context bar when usage is missing or placeholder zero", () => {
		render(<ContextWindow contextWindow={128000} lastApiReqTotalTokens={0} useAutoCondense={false} />)

		expect(screen.queryByLabelText("Context window usage progress")).not.toBeInTheDocument()
	})

	it("shows the context bar when reliable usage and context window are present", () => {
		render(<ContextWindow contextWindow={128000} lastApiReqTotalTokens={32000} useAutoCondense={false} />)

		expect(screen.getByLabelText("Context window usage progress")).toBeInTheDocument()
		expect(screen.queryByRole("button", { name: "Compact conversation" })).not.toBeInTheDocument()
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

	it("shows native SDK automatic compaction status when enabled", () => {
		render(
			<ContextWindow
				contextUsage={{ used: 16000, source: "estimated", reliable: false }}
				contextWindow={128000}
				useAutoCondense
			/>,
		)

		expect(screen.getByText(/SDK auto compaction enabled/)).toBeInTheDocument()
	})

	it("renders native automatic compaction status in Korean", () => {
		render(
			<ContextWindow
				contextUsage={{ used: 16000, source: "estimated", reliable: false }}
				contextWindow={128000}
				language="ko"
				useAutoCondense
			/>,
		)

		expect(screen.getByText(/SDK 자동 압축 사용/)).toBeInTheDocument()
		expect(screen.queryByRole("button", { name: "대화 압축" })).not.toBeInTheDocument()
	})

	it("uses the SDK-reported input budget and trigger after compaction", () => {
		render(
			<ContextWindow
				contextUsage={{
					used: 2_250,
					source: "reported",
					reliable: true,
					sdkMaxInputTokens: 4_500,
					sdkCompactionTriggerTokens: 4_050,
					sdkCompactionTargetTokens: 3_150,
				}}
				contextWindow={5_000}
				language="ko"
				useAutoCondense
			/>,
		)

		expect(screen.getByText(/50.0%/)).toBeInTheDocument()
		expect(screen.getByText(/SDK 압축 기준 90.0%/)).toBeInTheDocument()
		expect(screen.getByTitle("SDK가 보고한 실제 입력 한도")).toHaveTextContent("4.5k")
	})
})
