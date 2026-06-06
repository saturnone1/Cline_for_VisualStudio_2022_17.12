import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import AutoApproveBar from "./AutoApproveBar"

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		autoApprovalSettings: {
			enabled: false,
			actions: {
				readFiles: true,
				editFiles: false,
				executeSafeCommands: false,
				useBrowser: false,
				useMcp: false,
			},
			enableNotifications: false,
		},
		navigateToSettings: vi.fn(),
		yoloModeToggled: false,
	}),
}))

describe("AutoApproveBar", () => {
	it("shows the master off state instead of enabled action names", () => {
		render(<AutoApproveBar />)

		expect(screen.getByText("자동 승인:")).toBeInTheDocument()
		expect(screen.getByText("꺼짐")).toBeInTheDocument()
		expect(screen.queryByText("읽기")).not.toBeInTheDocument()
	})
})
