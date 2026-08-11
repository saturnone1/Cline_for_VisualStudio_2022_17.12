import type { McpMarketplaceCatalog, McpServer } from "@shared/mcp"
import type React from "react"
import { createContext, createElement, useContext, useState } from "react"

export interface McpState {
	mcpServers: McpServer[]
	mcpMarketplaceCatalog: McpMarketplaceCatalog
	setMcpServers: (value: McpServer[]) => void
	setMcpMarketplaceCatalog: (value: McpMarketplaceCatalog) => void
}

export function useMcpState(): McpState {
	const [mcpServers, setMcpServers] = useState<McpServer[]>([])
	const [mcpMarketplaceCatalog, setMcpMarketplaceCatalog] = useState<McpMarketplaceCatalog>({ items: [] })

	return { mcpServers, mcpMarketplaceCatalog, setMcpServers, setMcpMarketplaceCatalog }
}

const McpStateContext = createContext<McpState | undefined>(undefined)

export function McpStateProvider({ children }: { children: React.ReactNode }) {
	const value = useMcpState()
	return createElement(McpStateContext.Provider, { value }, children)
}

export function useMcpStateContext(): McpState {
	const context = useContext(McpStateContext)
	if (!context) {
		throw new Error("useMcpStateContext must be used within McpStateProvider")
	}
	return context
}
