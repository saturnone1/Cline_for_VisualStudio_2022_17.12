import type { McpMarketplaceCatalog, McpServer } from "@shared/mcp"
import { useState } from "react"

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
