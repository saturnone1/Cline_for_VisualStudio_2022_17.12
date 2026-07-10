import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import PreferredLanguageSetting from "./PreferredLanguageSetting"
import { updateSetting } from "./utils/settingsHandlers"

const mockState = vi.hoisted(() => ({
	uiLanguage: "ko",
	preferredLanguage: "English",
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeDropdown: ({ children, onChange, value, ...props }: any) => (
		<select onChange={onChange} value={value} {...props}>
			{children}
		</select>
	),
	VSCodeOption: ({ children, selected: _selected, ...props }: any) => <option {...props}>{children}</option>,
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		...mockState,
	}),
}))

vi.mock("./utils/settingsHandlers", () => ({
	updateSetting: vi.fn(),
}))

describe("PreferredLanguageSetting", () => {
	beforeEach(() => {
		mockState.uiLanguage = "ko"
		mockState.preferredLanguage = "English"
		vi.clearAllMocks()
	})

	it("persists the selected UI language separately from response language", () => {
		render(<PreferredLanguageSetting />)

		fireEvent.change(screen.getByLabelText("UI 언어"), { target: { value: "en" } })

		expect(updateSetting).toHaveBeenCalledWith("uiLanguage", "en")
	})

	it("persists the selected preferred language", () => {
		render(<PreferredLanguageSetting />)

		fireEvent.change(screen.getByLabelText("응답 언어"), { target: { value: "Korean - 한국어" } })

		expect(updateSetting).toHaveBeenCalledWith("preferredLanguage", "Korean - 한국어")
	})

	it("only offers English and Korean", () => {
		render(<PreferredLanguageSetting />)

		expect(screen.getAllByRole("option", { name: "영어" }).length).toBeGreaterThan(0)
		expect(screen.getAllByRole("option", { name: "한국어" }).length).toBeGreaterThan(0)
		expect(screen.queryByRole("option", { name: /Japanese/ })).not.toBeInTheDocument()
	})

	it("renders English UI independently from Korean response language", () => {
		mockState.uiLanguage = "en"
		mockState.preferredLanguage = "Korean - 한국어"

		render(<PreferredLanguageSetting />)

		expect(screen.getByLabelText("Interface Language")).toBeInTheDocument()
		expect(screen.getByLabelText("Response Language")).toHaveValue("Korean - 한국어")
	})
})
