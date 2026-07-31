import { render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import ChatErrorBoundary from "./ChatErrorBoundary"

function TranscriptRow({ malformed }: { malformed: boolean }) {
	if (malformed) throw new Error("malformed transcript")
	return <div>recovered row</div>
}

describe("ChatErrorBoundary", () => {
	afterEach(() => vi.restoreAllMocks())

	it("isolates one broken row and retries when its payload changes", () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined)
		const brokenPayload = { ts: 1, text: "same-length" }
		const view = render(
			<ChatErrorBoundary resetKey={brokenPayload}>
				<TranscriptRow malformed={true} />
			</ChatErrorBoundary>,
		)
		expect(screen.getByText("malformed transcript", { exact: false })).toBeInTheDocument()

		const repairedPayload = { ts: 1, text: "same-length" }
		view.rerender(
			<ChatErrorBoundary resetKey={repairedPayload}>
				<TranscriptRow malformed={false} />
			</ChatErrorBoundary>,
		)
		expect(screen.getByText("recovered row")).toBeInTheDocument()
	})
})
