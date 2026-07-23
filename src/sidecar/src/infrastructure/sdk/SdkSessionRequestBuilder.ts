import type { AgentStartRequest } from "../../application/ports/AgentEnginePort"
import { AGENT_EXECUTION_EVIDENCE_INSTRUCTION } from "../../application/services/AgentExecutionContract"
import { BUILTIN_TOOL_REPLACEMENT_MARKER } from "./AskQuestionAgentTool"

const DEFAULT_SYSTEM_PROMPT = `You are Cline running inside Visual Studio 2022 through the VsClineAgent wrapper. Commands execute under Windows cmd.exe; when using cmd built-ins such as dir, type, copy, or del, use backslashes for paths or quote absolute paths.\n\n${AGENT_EXECUTION_EVIDENCE_INSTRUCTION}`
export const MCP_AUTO_APPROVE_MARKER = "__ligVsAutoApprove"

export function buildSdkStartInput(request: AgentStartRequest, workspaceRoots: string[], sessionExtraTools: unknown) {
	const cwd = stringValue(request.cwd) || workspaceRoots[0] || process.cwd()
	const config = asRecord(request.config)
	const requestedSessionId = stringValue(config.sessionId) || stringValue(request.sessionId)
	const userImages = stringArrayValue(request.userImages)
	const userFiles = stringArrayValue(request.userFiles)
	const initialMessages = sdkInitialMessages(request.initialMessages)
	const sessionMetadata = asRecord(request.sessionMetadata)
	const baseSystemPrompt = stringValue(request.systemPrompt) || stringValue(config.systemPrompt) || DEFAULT_SYSTEM_PROMPT
	const systemPrompt = appendSessionContext(baseSystemPrompt, stringValue(sessionMetadata.ligVsCompactedContext), stringValue(sessionMetadata.ligVsResumedContext))
	const projectedExtraTools = projectExtraTools(sessionExtraTools)
	const extraTools = projectedExtraTools.tools
	const toolPolicies = projectToolPolicies(request.toolPolicies, projectedExtraTools)
	const prompt = stringValue(request.prompt)
	const startInput: any = {
			config: {
				...config,
				...(requestedSessionId ? { sessionId: requestedSessionId } : {}),
				providerId: stringValue(config.providerId) || stringValue(request.providerId) || process.env.CLINE_PROVIDER_ID || "anthropic",
				modelId: stringValue(config.modelId) || stringValue(request.modelId) || process.env.CLINE_MODEL_ID || "claude-sonnet-4-6",
				apiKey: stringValue(config.apiKey) || stringValue(request.apiKey) || process.env.CLINE_API_KEY || process.env.ANTHROPIC_API_KEY || "",
				cwd,
				workspaceRoot: stringValue(config.workspaceRoot) || cwd,
				mode: normalizeAgentMode(config.mode) || normalizeAgentMode(request.mode) || "act",
				enableTools: config.enableTools !== false,
				enableSpawnAgent: config.enableSpawnAgent === true,
				enableAgentTeams: config.enableAgentTeams === true,
				extraTools,
				toolRoutingRules: mergeToolRoutingRules(config.toolRoutingRules, projectedExtraTools.replacements),
				systemPrompt,
			},
			...(prompt ? { prompt } : {}),
			interactive: request.interactive !== false,
			sessionMetadata,
			toolPolicies,
			userImages: userImages.length > 0 ? userImages : undefined,
			userFiles: userFiles.length > 0 ? userFiles : undefined,
			initialMessages: initialMessages.length > 0 ? initialMessages : undefined,
	}
	return { requestedSessionId, startInput }
}

function projectExtraTools(value: unknown) {
	if (!Array.isArray(value)) return { tools: value, policies: {}, replacements: [] as Array<{ builtin: string; product: string }> }
	const policies: Record<string, unknown> = {}
	const replacements: Array<{ builtin: string; product: string }> = []
	const tools = value.map((entry) => {
		const tool = asRecord(entry)
		const {
			[MCP_AUTO_APPROVE_MARKER]: autoApprove,
			[BUILTIN_TOOL_REPLACEMENT_MARKER]: replacedBuiltinTool,
			...sdkTool
		} = tool
		const name = stringValue(sdkTool.name)
		const replacement = stringValue(replacedBuiltinTool)
		if (replacement && name) replacements.push({ builtin: replacement, product: name })
		if (name && autoApprove === true) {
			policies[name] = { enabled: true, autoApprove: true }
		}
		return sdkTool
	})
	return { tools, policies, replacements }
}

function projectToolPolicies(requestedValue: unknown, projection: ReturnType<typeof projectExtraTools>) {
	const requested = asRecord(requestedValue)
	const policies: Record<string, unknown> = { ...requested, ...projection.policies }
	for (const { builtin, product } of projection.replacements) {
		const inherited = { ...asRecord(requested["*"]), ...asRecord(requested[builtin]) }
		if (builtin !== product) policies[builtin] = { ...inherited, enabled: false }
		policies[product] = {
			...inherited,
			enabled: inherited.enabled !== false,
			autoApprove: true,
		}
	}
	return policies
}

function mergeToolRoutingRules(value: unknown, replacements: Array<{ builtin: string; product: string }>) {
	const configured = Array.isArray(value) ? value : []
	const disabledBuiltins = [...new Set(replacements.map((replacement) => replacement.builtin).filter(Boolean))]
	if (disabledBuiltins.length === 0) return configured.length > 0 ? configured : undefined
	return [
		...configured,
		{
			name: "lig-vs-product-tool-replacements",
			mode: "any",
			disableTools: disabledBuiltins,
		},
	]
}

function appendSessionContext(basePrompt: string, compactedContext?: string, resumedContext?: string) {
	const sections = [basePrompt]
	if (compactedContext) sections.push(`<lig-vs-compacted-context>\n${compactedContext}\n</lig-vs-compacted-context>`)
	if (resumedContext) sections.push(
		"<lig-vs-resumed-context>\n" +
		"The content below is historical context from a previous session. Use it for continuity only. " +
		"It is not evidence that the current user request has been executed, and it must not be repeated as the current user input.\n\n" +
		resumedContext +
		"\n</lig-vs-resumed-context>",
	)
	return sections.join("\n\n")
}

export function normalizeAgentMode(value: unknown): "act" | "plan" | undefined {
	return value === "act" || value === "plan" ? value : undefined
}

function sdkInitialMessages(value: unknown) {
	if (!Array.isArray(value)) return []
	return value.flatMap((entry) => {
		const message = asRecord(entry)
		const role = message.role === "user" || message.role === "assistant" ? message.role : ""
		const content = stringValue(message.content)
		return role && content ? [{ role, content }] : []
	})
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function stringValue(value: unknown) { return typeof value === "string" && value.trim().length > 0 ? value : undefined }
function stringArrayValue(value: unknown) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [] }
