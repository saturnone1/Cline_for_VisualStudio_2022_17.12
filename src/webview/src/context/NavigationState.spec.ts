import { act, renderHook } from "@testing-library/react"
import { useNavigationState } from "./NavigationState"

describe("useNavigationState", () => {
	it("keeps primary views mutually exclusive", () => {
		const { result } = renderHook(() => useNavigationState())

		act(() => result.current.navigateToSettingsModelPicker({ targetSection: "models", initialModelTab: "free" }))
		expect(result.current.showSettings).toBe(true)
		expect(result.current.settingsTargetSection).toBe("models")
		expect(result.current.settingsInitialModelTab).toBe("free")

		act(() => result.current.navigateToHistory())
		expect(result.current.showSettings).toBe(false)
		expect(result.current.showHistory).toBe(true)
		expect(result.current.showAccount).toBe(false)
		expect(result.current.showWorktrees).toBe(false)
	})

	it("closes MCP state when navigating back to chat", () => {
		const { result } = renderHook(() => useNavigationState())

		act(() => result.current.navigateToMcp("marketplace"))
		expect(result.current.showMcp).toBe(true)
		expect(result.current.mcpTab).toBe("marketplace")

		act(() => result.current.navigateToChat())
		expect(result.current.showMcp).toBe(false)
		expect(result.current.mcpTab).toBeUndefined()
	})

	it("clears transient settings selection when settings are hidden", () => {
		const { result } = renderHook(() => useNavigationState())

		act(() => result.current.navigateToSettingsModelPicker({ targetSection: "providers", initialModelTab: "recommended" }))
		act(() => result.current.hideSettings())

		expect(result.current.showSettings).toBe(false)
		expect(result.current.settingsTargetSection).toBeUndefined()
		expect(result.current.settingsInitialModelTab).toBeUndefined()
	})
})
