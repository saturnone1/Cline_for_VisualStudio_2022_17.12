import type { AgentStartRequest } from "../../application/ports/AgentEnginePort"

const DEFAULT_SYSTEM_PROMPT = "You are Cline running inside Visual Studio 2022 through the VsClineAgent wrapper. Commands execute under Windows cmd.exe; when using cmd built-ins such as dir, type, copy, or del, use backslashes for paths or quote absolute paths."

export function buildSdkStartInput(request: AgentStartRequest, workspaceRoots: string[], extraTools: unknown) {
	const cwd = stringValue(request.cwd) || workspaceRoots[0] || process.cwd()
	const config = asRecord(request.config)
	const requestedSessionId = stringValue(config.sessionId) || stringValue(request.sessionId)
	const userImages = stringArrayValue(request.userImages)
	const userFiles = stringArrayValue(request.userFiles)
	const initialMessages = sdkInitialMessages(request.initialMessages)
	const sessionMetadata = asRecord(request.sessionMetadata)
	const baseSystemPrompt = stringValue(request.systemPrompt) || stringValue(config.systemPrompt) || DEFAULT_SYSTEM_PROMPT
	const systemPrompt = appendCompactedContext(baseSystemPrompt, stringValue(sessionMetadata.ligVsCompactedContext))
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
				systemPrompt,
			},
			prompt: stringValue(request.prompt) || "",
			interactive: request.interactive !== false,
			sessionMetadata,
			toolPolicies: asRecord(request.toolPolicies),
			userImages: userImages.length > 0 ? userImages : undefined,
			userFiles: userFiles.length > 0 ? userFiles : undefined,
			initialMessages: initialMessages.length > 0 ? initialMessages : undefined,
	}
	return { requestedSessionId, startInput }
}

function appendCompactedContext(basePrompt: string, compactedContext?: string) {
	if (!compactedContext) return basePrompt
	return `${basePrompt}\n\n<lig-vs-compacted-context>\n${compactedContext}\n</lig-vs-compacted-context>`
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
