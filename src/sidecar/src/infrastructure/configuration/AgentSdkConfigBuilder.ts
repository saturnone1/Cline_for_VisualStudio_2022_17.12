import { normalizeSdkProviderId } from "../../application/services/ProviderIdentity"
import { AGENT_EXECUTION_EVIDENCE_INSTRUCTION } from "../../application/services/AgentExecutionContract"
import { selectProvider } from "../../features/providers/ProviderSelection"
import { normalizeOllamaOpenAiBaseUrl, normalizeOllamaRootBaseUrl } from "../models/ModelCatalog"
import { normalizePreferredLanguage, resolveApiKey, resolveBaseUrl, resolveConfiguredContextWindow, resolveOAuthCredentials } from "./ProviderConfiguration"
import { readPositiveIntEnv, RUNTIME_DEFAULTS } from "./RuntimeEnvironment"

type State = Readonly<Record<string, unknown>>
type Callbacks = Readonly<{
	state: () => State
	resolveModelId: (configuration: Record<string, unknown>, providerId: string, modePrefix: string, baseUrl: string) => Promise<string>
	scheduledAgentsEnabled: () => boolean
	log: (event: string, details: Record<string, unknown>) => void
}>

export class AgentSdkConfigBuilder {
	constructor(private readonly callbacks: Callbacks) {}

	async build(cwd: string, sessionId?: string) {
		const state = this.callbacks.state(), apiConfig = asRecord(state.apiConfiguration)
		const mode = state.mode === "plan" ? "plan" : "act"
		const { modePrefix, providerId } = selectProvider(apiConfig, mode, process.env.CLINE_PROVIDER_ID || "anthropic")
		const sdkProviderId = normalizeSdkProviderId(providerId)
		const configuredBaseUrl = resolveBaseUrl(apiConfig, providerId)
		const modelLookupBaseUrl = providerId === "ollama" ? normalizeOllamaRootBaseUrl(configuredBaseUrl) : configuredBaseUrl
		const sdkBaseUrl = providerId === "ollama" ? normalizeOllamaOpenAiBaseUrl(configuredBaseUrl) : configuredBaseUrl
		const modelId = await this.callbacks.resolveModelId(apiConfig, providerId, modePrefix, modelLookupBaseUrl)
		const oauthCredentials = resolveOAuthCredentials(apiConfig, providerId)
		const oauthAccessToken = readString(oauthCredentials.accessToken) || readString(oauthCredentials.access_token)
		const apiKey = resolveApiKey(apiConfig, providerId) || oauthAccessToken || process.env.CLINE_API_KEY || process.env.ANTHROPIC_API_KEY || ""
		const maxTokensPerTurn = readOptionalPositiveIntEnv("VSCLINE_MAX_TOKENS_PER_TURN")
		const apiTimeoutMs = resolveRequestTimeoutMs(apiConfig)
		const reasoningEffort = resolveReasoningEffort(apiConfig, modePrefix)
		const thinking = resolveThinkingEnabled(apiConfig, modePrefix, providerId, reasoningEffort)
		const contextWindowTokens = resolveConfiguredContextWindow(apiConfig, providerId, modePrefix, modelId)
		const maxIterations = readOptionalPositiveIntEnv("VSCLINE_MAX_ITERATIONS")
		const maxParallelToolCalls = state.enableParallelToolCalling === true ? readOptionalPositiveIntEnv("VSCLINE_MAX_PARALLEL_TOOL_CALLS") : 1
		const execution = buildOptionalExecutionConfig()
		const subagentsEnabled = state.subagentsEnabled === true || process.env.VSCLINE_ENABLE_SUBAGENTS === "1"
		const scheduledAgentsEnabled = this.callbacks.scheduledAgentsEnabled()
		const preferredLanguage = normalizePreferredLanguage(readString(state.preferredLanguage))
		const languageInstruction = preferredLanguage === "Korean - 한국어" ? "Reply to the user in Korean unless the user explicitly asks for another language." : "Reply to the user in English unless the user explicitly asks for another language."
		const strictPlanMode = state.strictPlanModeEnabled === true
		const modeInstruction = mode === "plan"
			? strictPlanMode
				? "You are in PLAN mode with Strict Plan Mode enabled. Do not modify files. Inspect as needed and return a concrete plan for the user to approve before implementation."
				: "You are in PLAN mode. Use the tools allowed by the current settings to investigate the request, and return a concrete plan for the user to approve before implementation."
			: "You are in ACT mode. You may implement approved changes using the available Visual Studio tools while keeping actions scoped to the user's request."
		const customPrompt = readString(state.customPrompt).trim()
		const systemPrompt = [
			`You are LIG VS running inside Visual Studio 2022 through the VsClineAgent SDK wrapper. ${languageInstruction} ${modeInstruction} Commands execute under Windows cmd.exe; when using cmd built-ins such as dir, type, copy, or del, use backslashes for paths or quote absolute paths.`,
			AGENT_EXECUTION_EVIDENCE_INSTRUCTION,
			customPrompt ? `Additional user-defined instructions:\n${customPrompt}` : "",
		].filter(Boolean).join("\n\n")
		// ContextWindow and CompactSessionFlow own thresholding, confirmation, and durable summaries.
		const sdkCompaction = { enabled: false } as const

		this.callbacks.log("sdkConfig", { providerId: sdkProviderId, modelId, baseUrl: sdkBaseUrl || undefined, mode, maxTokensPerTurn, apiTimeoutMs, thinking, reasoningEffort, contextWindowTokens, useAutoCondense: state.useAutoCondense === true, sessionId: sessionId || undefined, maxIterations, maxParallelToolCalls, subagentsEnabled, scheduledAgentsEnabled, oauthConfigured: Object.keys(oauthCredentials).length > 0, execution, preferredLanguage })
		return { providerId: sdkProviderId, modelId, sessionId: sessionId || undefined, apiKey, baseUrl: sdkBaseUrl || undefined, cwd, workspaceRoot: cwd, mode, enableTools: true, enableSpawnAgent: subagentsEnabled, enableAgentTeams: subagentsEnabled, ...(maxIterations ? { maxIterations } : {}), ...(maxParallelToolCalls ? { maxParallelToolCalls } : {}), ...(maxTokensPerTurn ? { maxTokensPerTurn } : {}), ...(apiTimeoutMs ? { apiTimeoutMs } : {}), thinking, reasoningEffort, providerConfig: { ...(maxTokensPerTurn ? { maxTokens: maxTokensPerTurn } : {}), ...(apiTimeoutMs ? { timeout: apiTimeoutMs } : {}), ...(Object.keys(oauthCredentials).length > 0 ? { oauthCredentials } : {}), reasoning: { enabled: thinking, effort: reasoningEffort } }, checkpoint: { enabled: state.enableCheckpointsSetting !== false }, compaction: sdkCompaction, ...(execution ? { execution } : {}), preferredLanguage, systemPrompt }
	}
}

function resolveRequestTimeoutMs(apiConfig: Record<string, unknown>) { const configured = numberValue(apiConfig.requestTimeoutMs) || numberValue(apiConfig.apiTimeoutMs) || numberValue(apiConfig.openAiRequestTimeoutMs) || numberValue(apiConfig.openAiCompatibleRequestTimeoutMs); return configured && configured > 0 ? configured : readPositiveIntEnv("VSCLINE_API_TIMEOUT_MS", RUNTIME_DEFAULTS.apiRequestTimeoutMs) }
function resolveReasoningEffort(apiConfig: Record<string, unknown>, modePrefix: string) { const candidates = [readString(apiConfig[`${modePrefix}ReasoningEffort`]), readString(apiConfig[`${modePrefix}OpenAiReasoningEffort`]), readString(apiConfig.reasoningEffort), readString(apiConfig.openAiReasoningEffort), readString(apiConfig.openAiCompatibleReasoningEffort)].map((value) => value.trim().toLowerCase()).filter(Boolean); for (const value of candidates) if (["low", "medium", "high", "xhigh", "none"].includes(value)) return value as "low" | "medium" | "high" | "xhigh" | "none"; return process.env.VSCLINE_REASONING_EFFORT as "low" | "medium" | "high" | "xhigh" | "none" | undefined }
function resolveThinkingEnabled(apiConfig: Record<string, unknown>, modePrefix: string, providerId: string, effort?: string) { const values = [booleanValue(apiConfig[`${modePrefix}EnableThinking`]), booleanValue(apiConfig[`${modePrefix}ThinkingEnabled`]), booleanValue(apiConfig.enableThinking), booleanValue(apiConfig.thinking), booleanValue(apiConfig.openAiThinkingEnabled), booleanValue(apiConfig.openAiCompatibleThinkingEnabled)].filter((value): value is boolean => value !== undefined); if (values.length) return values[0]; if (effort === "none") return false; if (effort) return true; if (providerId === "openai" || providerId === "openai-compatible") return false; return undefined }
function buildOptionalExecutionConfig() { const execution: Record<string, unknown> = {}, mistakes = readOptionalPositiveIntEnv("VSCLINE_MAX_CONSECUTIVE_MISTAKES"), reminder = readOptionalPositiveIntEnv("VSCLINE_REMINDER_AFTER_ITERATIONS"), loopDetection = readLoopDetectionConfig(); if (mistakes) execution.maxConsecutiveMistakes = mistakes; if (reminder) execution.reminderAfterIterations = reminder; if (loopDetection !== undefined) execution.loopDetection = loopDetection; return Object.keys(execution).length ? execution : undefined }
function readLoopDetectionConfig() { const value = process.env.VSCLINE_LOOP_DETECTION?.trim().toLowerCase(); if (!value) return undefined; if (["0", "false", "off"].includes(value)) return false; return { softThreshold: readOptionalPositiveIntEnv("VSCLINE_LOOP_SOFT_THRESHOLD") || 3, hardThreshold: readOptionalPositiveIntEnv("VSCLINE_LOOP_HARD_THRESHOLD") || 5 } }
function readOptionalPositiveIntEnv(name: string) { const value = Number.parseInt(process.env[name] || "", 10); return Number.isFinite(value) && value > 0 ? value : undefined }
function numberValue(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : undefined }
function booleanValue(value: unknown) { return typeof value === "boolean" ? value : undefined }
function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function readString(value: unknown) { return typeof value === "string" ? value : "" }
