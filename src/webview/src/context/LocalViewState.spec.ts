import { act, renderHook } from "@testing-library/react"
import { useMcpState } from "./McpState"
import { useRuntimeViewState } from "./RuntimeViewState"

describe("local WebView state", () => {
	it("owns MCP server and marketplace state independently", () => {
		const { result } = renderHook(() => useMcpState())
		const replacementCatalog = { items: [] }

		expect(result.current.mcpServers).toEqual([])
		expect(result.current.mcpMarketplaceCatalog.items).toEqual([])
		act(() => result.current.setMcpMarketplaceCatalog(replacementCatalog))
		expect(result.current.mcpMarketplaceCatalog).toBe(replacementCatalog)
	})

	it("owns runtime-only view state independently", () => {
		const { result } = renderHook(() => useRuntimeViewState())

		expect(result.current.showWelcome).toBe(false)
		expect(result.current.expandTaskHeader).toBe(true)
		act(() => {
			result.current.setShowWelcome(true)
			result.current.setTotalTasksSize(42)
			result.current.setExpandTaskHeader(false)
		})
		expect(result.current.showWelcome).toBe(true)
		expect(result.current.totalTasksSize).toBe(42)
		expect(result.current.expandTaskHeader).toBe(false)
	})
})
