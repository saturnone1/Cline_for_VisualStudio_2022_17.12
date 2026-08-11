import type { ClineMessage } from "@shared/ExtensionMessage"
import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { CommandOutputRow } from "./CommandOutputRow"

vi.mock("../common/CodeBlock", () => ({
	default: ({ source }: { source?: string }) => <pre>{source}</pre>,
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		uiLanguage: "ko",
	}),
}))

const renderCommand = (text: string) => {
	const message: ClineMessage = {
		ts: 1,
		type: "ask",
		ask: "command",
		text,
	}

	return render(
		<CommandOutputRow
			isOutputFullyExpanded={false}
			message={message}
			setIsOutputFullyExpanded={vi.fn()}
			title={<span>LIG VS wants to execute this command:</span>}
		/>,
	)
}

describe("CommandOutputRow", () => {
	it("shows the actual command line from approval JSON payloads", () => {
		renderCommand(JSON.stringify({ command: "dir docker_asp", description: "LIG VS wants to run this command." }))

		expect(screen.getAllByText(/dir docker_asp/).length).toBeGreaterThan(0)
		expect(screen.queryByText(/description/)).not.toBeInTheDocument()
	})

	it("normalizes command arrays into a readable shell line", () => {
		renderCommand(JSON.stringify({ commands: ["dir docker_asp", "dir src"] }))

		expect(screen.getAllByText(/dir docker_asp && dir src/).length).toBeGreaterThan(0)
	})
})
