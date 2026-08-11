import { act, renderHook } from "@testing-library/react"
import { vi } from "vitest"
import { useContextMentionMenu } from "./useContextMentionMenu"

const clearMentionSearch = vi.fn()
const scheduleMentionSearch = vi.fn()

vi.mock("@/services/grpcClient", () => ({
	FileServiceClient: { searchCommits: vi.fn() },
}))

vi.mock("./useMentionSearch", () => ({
	useMentionSearch: () => ({
		fileSearchResults: [],
		searchLoading: false,
		runMentionSearch: vi.fn(),
		scheduleMentionSearch,
		clearMentionSearch,
	}),
}))

describe("useContextMentionMenu", () => {
	beforeEach(() => {
		clearMentionSearch.mockClear()
		scheduleMentionSearch.mockClear()
	})

	it("opens for an @ query and schedules the matching search", () => {
		const { result } = renderHook(() =>
			useContextMentionMenu({
				cursorPosition: 4,
				setCursorPosition: vi.fn(),
				setInputValue: vi.fn(),
				setIntendedCursorPosition: vi.fn(),
				textAreaRef: { current: null },
			}),
		)

		act(() => result.current.updateMentionMenu("@src", 4, false))

		expect(result.current.showContextMenu).toBe(true)
		expect(result.current.searchQuery).toBe("src")
		expect(scheduleMentionSearch).toHaveBeenCalledWith("src", null)
	})

	it("keeps the mention menu closed while the slash menu has precedence", () => {
		const { result } = renderHook(() =>
			useContextMentionMenu({
				cursorPosition: 4,
				setCursorPosition: vi.fn(),
				setInputValue: vi.fn(),
				setIntendedCursorPosition: vi.fn(),
				textAreaRef: { current: null },
			}),
		)

		act(() => result.current.updateMentionMenu("@src", 4, true))

		expect(result.current.showContextMenu).toBe(false)
		expect(result.current.searchQuery).toBe("")
		expect(scheduleMentionSearch).not.toHaveBeenCalled()
	})
})
