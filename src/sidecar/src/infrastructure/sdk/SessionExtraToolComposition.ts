import { wrapAgentToolFailureContext } from "./AgentToolFailureBoundary"

type Dependencies = Readonly<{
	loadMcpTools: () => Promise<readonly unknown[] | undefined>
	loadHostTools: () => readonly unknown[]
	loadProductTools?: () => readonly unknown[]
	log: (level: string, message: string, metadata?: unknown) => void
}>

export async function createSessionExtraTools(dependencies: Dependencies) {
	let mcpTools: readonly unknown[] = []
	try {
		mcpTools = await dependencies.loadMcpTools() || []
	} catch (error) {
		dependencies.log("warn", "MCP tools are unavailable for this session; continuing without them", {
			error: error instanceof Error ? error.message : String(error),
		})
	}

	const combined = [...mcpTools, ...dependencies.loadHostTools(), ...(dependencies.loadProductTools?.() || [])]
		.map((value) => {
			const tool = asRecord(value)
			const name = typeof tool.name === "string" && tool.name.trim() ? tool.name.trim() : "unnamed-extra-tool"
			return wrapAgentToolFailureContext(tool, name, (message) => dependencies.log("warn", "Agent tool execution failed", { toolName: name, error: message }))
		})
	return combined.length > 0 ? combined : undefined
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
