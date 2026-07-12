export type CapabilityStatus = "supported" | "partial" | "unsupported"
export type CapabilityOwner = "cline-sdk" | "visual-studio-host"
export type Capability = Readonly<{ id: string; label: string; status: CapabilityStatus; owner?: CapabilityOwner; reason?: string }>

const capabilities: readonly Capability[] = [
	...withStatus("supported", [
		["sessions", "Sessions", "cline-sdk"], ["history", "History", "cline-sdk"], ["messages", "Messages", "cline-sdk"],
		["settings", "Rules, workflows, skills", "cline-sdk"], ["tool-approval", "Tool approvals", "cline-sdk"], ["streaming", "Streaming output", "cline-sdk"],
		["terminal-command-host", "VS command host attach/continue/cancel", "visual-studio-host"], ["checkpoints", "Checkpoint restore and snapshot comments", "cline-sdk"],
		["usage", "Token and cost usage", "cline-sdk"], ["mcp", "MCP server settings and tools", "cline-sdk"],
		["browser-devtools", "Browser DevTools sessions and phases", "visual-studio-host"], ["auth", "Provider-scoped OAuth and token state", "cline-sdk"],
		["models", "Provider catalog refresh diagnostics", "cline-sdk"], ["worktrees", "Worktree routing and merge recovery", "visual-studio-host"],
		["hooks", "Local lifecycle hooks", "cline-sdk"], ["scheduled-agents", "Workspace scheduled agents", "cline-sdk"],
		["plugins-local", "Local plugin discovery and config status", "cline-sdk"], ["subagents", "Subagent and team progress", "cline-sdk"],
	]),
	...withStatus("partial", [
		["mcp-marketplace", "MCP marketplace install", "cline-sdk"], ["remote-mcp-oauth", "Remote MCP OAuth callbacks", "cline-sdk"],
		["browser-auto-launch", "Automatic browser relaunch", "cline-sdk"], ["global-account-billing", "Global Cline account billing/org controls", "cline-sdk"],
		["sdk-checkpoint-diff-streams", "SDK checkpoint diff streams", "cline-sdk"], ["scheduler-queue-controls", "Hosted scheduler queue controls", "cline-sdk"],
		["provider-specific-catalogs", "Non-OpenAI provider-specific catalog APIs", "cline-sdk"],
	]),
	{ id: "vscode-terminal-api", label: "VS Code terminal shell integration", status: "unsupported", reason: "Visual Studio 2022 exposes a different terminal automation surface than VS Code." },
	{ id: "vscode-editor-diff", label: "VS Code native diff/checkpoint UI", status: "unsupported", reason: "The VSIX must use Visual Studio editor and diff services instead of VS Code commands." },
	{ id: "vscode-auth", label: "VS Code authentication providers", status: "unsupported", reason: "Visual Studio 2022 does not provide the same extension authentication provider API." },
	{ id: "vscode-worktrees", label: "VS Code worktree UI commands", status: "unsupported", reason: "The upstream commands are VS Code command IDs and need Visual Studio-specific replacements." },
	{ id: "webview-uri", label: "VS Code webview URI helpers", status: "unsupported", reason: "WebView2 assets and local resource loading are hosted through the VSIX package." },
]

export class CapabilityRegistry {
	private readonly byId = new Map(capabilities.map((capability) => [capability.id, capability]))
	get(id: string) { return this.byId.get(id) }
	isSupported(id: string) { return this.get(id)?.status === "supported" }
	list(status?: CapabilityStatus) { return capabilities.filter((capability) => !status || capability.status === status) }
	coverage() {
		const project = (status: CapabilityStatus) => this.list(status).map(({ status: _, ...capability }) => capability)
		return { supported: project("supported"), partial: project("partial"), visualStudioUnsupported: project("unsupported") }
	}
}

export const capabilityRegistry = new CapabilityRegistry()

function withStatus(status: CapabilityStatus, items: ReadonlyArray<readonly [string, string, CapabilityOwner]>): Capability[] {
	return items.map(([id, label, owner]) => ({ id, label, owner, status }))
}
