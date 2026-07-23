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
	return combined.length > 0 ? combined : undefined
}
