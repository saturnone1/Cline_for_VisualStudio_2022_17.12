import { act, renderHook } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { McpStateProvider, useMcpState, useMcpStateContext } from "./McpState"
import { RuntimeViewStateProvider, useRuntimeViewState, useRuntimeViewStateContext } from "./RuntimeViewState"

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

	it("exposes MCP and runtime slices through independent providers", () => {
		const mcpWrapper = ({ children }: { children: ReactNode }) =>
			createElement(McpStateProvider, null, children)
		const runtimeWrapper = ({ children }: { children: ReactNode }) =>
			createElement(RuntimeViewStateProvider, null, children)
		const mcp = renderHook(() => useMcpStateContext(), { wrapper: mcpWrapper })
		const runtime = renderHook(() => useRuntimeViewStateContext(), { wrapper: runtimeWrapper })

		act(() => mcp.result.current.setMcpServers([{ name: "connected" }] as never))
		act(() => runtime.result.current.setExpandTaskHeader(false))

		expect(mcp.result.current.mcpServers).toHaveLength(1)
		expect(runtime.result.current.expandTaskHeader).toBe(false)
	})
})
