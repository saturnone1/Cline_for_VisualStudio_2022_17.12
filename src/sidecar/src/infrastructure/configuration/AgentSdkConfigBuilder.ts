import { normalizeSdkProviderId } from "../../application/services/ProviderIdentity"
import { createVisualStudioAgentSystemPrompt } from "../../application/services/AgentExecutionContract"
import { createAgentMistakeRecoveryPolicy } from "../../application/services/AgentMistakeRecoveryPolicy"
import { selectProvider } from "../../features/providers/ProviderSelection"
import { isOllamaOpenAiCompatibleEndpoint, normalizeOllamaOpenAiBaseUrl, normalizeOllamaRootBaseUrl } from "../models/ModelCatalog"
import { normalizePreferredLanguage, resolveApiKey, resolveBaseUrl, resolveConfiguredContextWindow, resolveOAuthCredentials } from "./ProviderConfiguration"
import { readPositiveIntEnv, RUNTIME_DEFAULTS } from "./RuntimeEnvironment"
import type { ClineSdkStartConfig } from "../sdk/ClineSdkContract"
import type { AgentConnectionUpdateRequest } from "../../application/ports/AgentEnginePort"

type State = Readonly<Record<string, unknown>>
type Callbacks = Readonly<{
	state: () => State
	resolveModelId: (configuration: Record<string, unknown>, providerId: string, modePrefix: string, baseUrl: string) => Promise<string>
	log: (event: string, details: Record<string, unknown>) => void
}>

export class AgentSdkConfigBuilder {
	constructor(private readonly callbacks: Callbacks) {}

	async build(cwd: string, sessionId?: string): Promise<ClineSdkStartConfig> {
		const state = this.callbacks.state(), apiConfig = asRecord(state.apiConfiguration)
		const mode = state.mode === "plan" ? "plan" : "act"
		const { modePrefix, providerId } = selectProvider(apiConfig, mode, process.env.CLINE_PROVIDER_ID || "anthropic")
		const configuredBaseUrl = resolveBaseUrl(apiConfig, providerId)
		const ollamaOpenAiCompatibility = providerId === "ollama" && isOllamaOpenAiCompatibleEndpoint(configuredBaseUrl)
		const sdkProviderId = ollamaOpenAiCompatibility ? "openai-compatible" : normalizeSdkProviderId(providerId)
		const modelLookupBaseUrl = providerId === "ollama" ? normalizeOllamaRootBaseUrl(configuredBaseUrl) : configuredBaseUrl
		const sdkBaseUrl = providerId === "ollama"
			? ollamaOpenAiCompatibility
				? normalizeOllamaOpenAiBaseUrl(configuredBaseUrl)
				: normalizeOllamaRootBaseUrl(configuredBaseUrl)
			: configuredBaseUrl
		const modelId = await this.callbacks.resolveModelId(apiConfig, providerId, modePrefix, modelLookupBaseUrl)
		const oauthCredentials = resolveOAuthCredentials(apiConfig, providerId)
		const oauthAccessToken = readString(oauthCredentials.accessToken) || readString(oauthCredentials.access_token)
		const apiKey = resolveApiKey(apiConfig, providerId) || oauthAccessToken || process.env.CLINE_API_KEY || process.env.ANTHROPIC_API_KEY || ""
		const maxTokensPerTurn = readOptionalPositiveIntEnv("VSCLINE_MAX_TOKENS_PER_TURN")
		const apiTimeoutMs = resolveRequestTimeoutMs(apiConfig)
		const reasoningEffort = resolveReasoningEffort(apiConfig, modePrefix)
		const thinking = resolveThinkingEnabled(apiConfig, modePrefix, providerId, reasoningEffort)
		const sdkReasoningEffort = reasoningEffort === "none" ? undefined : reasoningEffort
		const contextWindowTokens = resolveConfiguredContextWindow(apiConfig, providerId, modePrefix, modelId)
		const maxIterations = readOptionalPositiveIntEnv("VSCLINE_MAX_ITERATIONS")
		const maxParallelToolCalls = state.enableParallelToolCalling === true ? readOptionalPositiveIntEnv("VSCLINE_MAX_PARALLEL_TOOL_CALLS") : 1
		const execution = buildOptionalExecutionConfig()
		const subagentsEnabled = state.subagentsEnabled === true || process.env.VSCLINE_ENABLE_SUBAGENTS === "1"
		const preferredLanguage = normalizePreferredLanguage(readString(state.preferredLanguage))
		const languageInstruction = preferredLanguage === "Korean - 한국어" ? "Reply to the user in Korean unless the user explicitly asks for another language." : "Reply to the user in English unless the user explicitly asks for another language."
		const customPrompt = readString(state.customPrompt).trim()
		const systemPrompt = createVisualStudioAgentSystemPrompt({ languageInstruction, customInstructions: customPrompt })
		const modelInfo = contextWindowTokens ? { id: modelId, contextWindow: contextWindowTokens } : undefined
		const sdkCompaction = state.useAutoCondense === true
			? { enabled: true, strategy: "agentic" as const }
			: { enabled: false }
		const providerConfig = {
			providerId: sdkProviderId,
			modelId,
			...(apiKey ? { apiKey } : {}),
			...(sdkBaseUrl ? { baseUrl: sdkBaseUrl } : {}),
			...(apiTimeoutMs ? { timeoutMs: apiTimeoutMs } : {}),
			...(maxTokensPerTurn ? { maxOutputTokens: maxTokensPerTurn } : {}),
			...(modelInfo ? { modelInfo } : {}),
			...oauthCredentials,
			...(thinking !== undefined ? { thinking } : {}),
			...(sdkReasoningEffort ? { reasoningEffort: sdkReasoningEffort } : {}),
		}
		const onConsecutiveMistakeLimitReached = createAgentMistakeRecoveryPolicy((event, details) => this.callbacks.log(event, details))

		this.callbacks.log("sdkConfig", { providerId: sdkProviderId, configuredProviderId: providerId, protocol: ollamaOpenAiCompatibility ? "openai-compatible" : "native", modelId, baseUrl: sdkBaseUrl || undefined, mode, maxTokensPerTurn, apiTimeoutMs, thinking, reasoningEffort, contextWindowTokens, useAutoCondense: state.useAutoCondense === true, sessionId: sessionId || undefined, maxIterations, maxParallelToolCalls, subagentsEnabled, oauthConfigured: Object.keys(oauthCredentials).length > 0, execution, preferredLanguage })
		return { providerId: sdkProviderId, modelId, sessionId: sessionId || undefined, apiKey, baseUrl: sdkBaseUrl || undefined, cwd, workspaceRoot: cwd, mode, enableTools: true, enableSpawnAgent: subagentsEnabled, enableAgentTeams: subagentsEnabled, ...(maxIterations ? { maxIterations } : {}), ...(maxParallelToolCalls ? { maxParallelToolCalls } : {}), ...(maxTokensPerTurn ? { maxTokensPerTurn } : {}), thinking, ...(sdkReasoningEffort ? { reasoningEffort: sdkReasoningEffort } : {}), providerConfig, ...(modelInfo ? { knownModels: { [modelId]: modelInfo } } : {}), checkpoint: { enabled: state.enableCheckpointsSetting !== false }, compaction: sdkCompaction, ...(execution ? { execution } : {}), onConsecutiveMistakeLimitReached, systemPrompt }
	}
}

function resolveRequestTimeoutMs(apiConfig: Record<string, unknown>) { const configured = numberValue(apiConfig.requestTimeoutMs) || numberValue(apiConfig.apiTimeoutMs) || numberValue(apiConfig.openAiRequestTimeoutMs) || numberValue(apiConfig.openAiCompatibleRequestTimeoutMs); return configured && configured > 0 ? configured : readPositiveIntEnv("VSCLINE_API_TIMEOUT_MS", RUNTIME_DEFAULTS.apiRequestTimeoutMs) }
function resolveReasoningEffort(apiConfig: Record<string, unknown>, modePrefix: string) { const candidates = [readString(apiConfig[`${modePrefix}ReasoningEffort`]), readString(apiConfig[`${modePrefix}OpenAiReasoningEffort`]), readString(apiConfig.reasoningEffort), readString(apiConfig.openAiReasoningEffort), readString(apiConfig.openAiCompatibleReasoningEffort)].map((value) => value.trim().toLowerCase()).filter(Boolean); for (const value of candidates) if (["low", "medium", "high", "xhigh", "none"].includes(value)) return value as "low" | "medium" | "high" | "xhigh" | "none"; return process.env.VSCLINE_REASONING_EFFORT as "low" | "medium" | "high" | "xhigh" | "none" | undefined }
function resolveThinkingEnabled(apiConfig: Record<string, unknown>, modePrefix: string, providerId: string, effort?: string) { const values = [booleanValue(apiConfig[`${modePrefix}EnableThinking`]), booleanValue(apiConfig[`${modePrefix}ThinkingEnabled`]), booleanValue(apiConfig.enableThinking), booleanValue(apiConfig.thinking), booleanValue(apiConfig.openAiThinkingEnabled), booleanValue(apiConfig.openAiCompatibleThinkingEnabled)].filter((value): value is boolean => value !== undefined); if (values.length) return values[0]; if (effort === "none") return false; if (effort) return true; if (providerId === "openai" || providerId === "openai-compatible") return false; return undefined }
function buildOptionalExecutionConfig() {
	const execution: Record<string, unknown> = {}
	const mistakes = readOptionalPositiveIntEnv("VSCLINE_MAX_CONSECUTIVE_MISTAKES")
	const reminder = readOptionalPositiveIntEnv("VSCLINE_REMINDER_AFTER_ITERATIONS")
	const loopDetection = readLoopDetectionConfig()
	if (mistakes) execution.maxConsecutiveMistakes = mistakes
	if (reminder) execution.reminderAfterIterations = reminder
	if (loopDetection !== undefined) execution.loopDetection = loopDetection
	return Object.keys(execution).length ? execution : undefined
}

export function createConnectionUpdate(sessionId: string, config: ClineSdkStartConfig): AgentConnectionUpdateRequest {
	return {
		sessionId,
		providerId: config.providerId,
		modelId: config.modelId,
		apiKey: config.apiKey || "",
		baseUrl: config.baseUrl || "",
		providerConfig: asRecord(config.providerConfig),
		thinking: config.thinking ?? null,
		reasoningEffort: config.reasoningEffort ?? null,
		thinkingBudgetTokens: config.thinkingBudgetTokens ?? null,
	}
}
function readLoopDetectionConfig() {
	const value = process.env.VSCLINE_LOOP_DETECTION?.trim().toLowerCase()
	// The SDK compares tool name and input only, so successful status polling is
	// indistinguishable from a loop. Keep that heuristic opt-in and let actual
	// tool failures flow through the mistake recovery callback instead.
	if (!value || ["0", "false", "off"].includes(value)) return undefined
	return { softThreshold: readOptionalPositiveIntEnv("VSCLINE_LOOP_SOFT_THRESHOLD") || 3, hardThreshold: readOptionalPositiveIntEnv("VSCLINE_LOOP_HARD_THRESHOLD") || 5 }
}
function readOptionalPositiveIntEnv(name: string) { const value = Number.parseInt(process.env[name] || "", 10); return Number.isFinite(value) && value > 0 ? value : undefined }
function numberValue(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : undefined }
function booleanValue(value: unknown) { return typeof value === "boolean" ? value : undefined }
function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function readString(value: unknown) { return typeof value === "string" ? value : "" }
