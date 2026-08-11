import type { AgentEnginePort } from "../../application/ports/AgentEnginePort"
import type { TaskSessionUseCase } from "../../application/useCases/TaskSessionUseCase"
import type { BrowserHandler } from "../../features/browser/BrowserHandler"
import type { CancelTaskHandler } from "../../features/chat/cancelTask/CancelTaskHandler"
import type { SendMessageHandler } from "../../features/chat/sendMessage/SendMessageHandler"
import type { StartTaskHandler } from "../../features/chat/startTask/StartTaskHandler"
import type { CheckpointHandler } from "../../features/checkpoints/CheckpointHandler"
import type { HookExecutionHandler } from "../../features/hooks/HookExecutionHandler"
import type { HookSettingsHandler } from "../../features/hooks/HookSettingsHandler"
import type { McpHandler } from "../../features/mcp/McpHandler"
import type { OAuthAuthorizationHandler } from "../../features/providers/OAuthAuthorizationHandler"
import type { OAuthCallbackHandler } from "../../features/providers/OAuthCallbackHandler"
import type { ProviderAuthActionHandler } from "../../features/providers/ProviderAuthActionHandler"
import type { ProviderCredentialHandler } from "../../features/providers/ProviderCredentialHandler"
import type { TaskActivityMonitor } from "../../features/runtime/TaskActivityMonitor"
import type { PartialStateScheduler } from "../../features/runtime/PartialStateScheduler"
import type { SendLatencyMonitor } from "../../features/runtime/SendLatencyMonitor"
import type { ScheduledAgentHandler } from "../../features/scheduledAgents/ScheduledAgentHandler"
import type { SdkSettingsHandler } from "../../features/settings/SdkSettingsHandler"
import type { WorktreeMutationHandler } from "../../features/worktrees/WorktreeMutationHandler"
import type { WorktreeQueryHandler } from "../../features/worktrees/WorktreeQueryHandler"
import type { TerminalActivityMonitor } from "../conversation/TerminalActivityMonitor"
import type { ProviderModelCatalogHandler } from "../models/ProviderModelCatalogHandler"
import type { ChangeTrackingHandler } from "../workspace/ChangeTrackingHandler"
import type { WebviewStreamPublisher } from "./WebviewStreamPublisher"

export type WebviewFeatures = {
	agentEngine: AgentEnginePort
	taskSessions: TaskSessionUseCase
	mcp: McpHandler
	sendMessage: SendMessageHandler
	startTask: StartTaskHandler
	cancelTask: CancelTaskHandler
	browser: BrowserHandler
	worktreeQueries: WorktreeQueryHandler
	worktreeMutations: WorktreeMutationHandler
	oauthAuthorization: OAuthAuthorizationHandler
	oauthCallback: OAuthCallbackHandler
	providerCredentials: ProviderCredentialHandler
	providerAuthActions: ProviderAuthActionHandler
	scheduledAgents: ScheduledAgentHandler
	hookSettings: HookSettingsHandler
	hookExecution: HookExecutionHandler
	checkpoints: CheckpointHandler
	terminalActivity: TerminalActivityMonitor
	taskActivity: TaskActivityMonitor
	partialState: PartialStateScheduler
	sendLatency: SendLatencyMonitor
	changeTracking: ChangeTrackingHandler
	providerModelCatalogs: ProviderModelCatalogHandler
	streamPublisher: WebviewStreamPublisher
	sdkSettings: SdkSettingsHandler
}

export type RuntimeWebviewFeatures = Omit<WebviewFeatures, "streamPublisher">

const labels: Record<keyof WebviewFeatures, string> = {
	agentEngine: "LIG VS SDK runtime",
	taskSessions: "Task session use case",
	mcp: "LIG VS MCP application service",
	sendMessage: "SendMessageHandler",
	startTask: "StartTaskHandler",
	cancelTask: "CancelTaskHandler",
	browser: "Browser feature handler",
	worktreeQueries: "Worktree query handler",
	worktreeMutations: "Worktree mutation handler",
	oauthAuthorization: "OAuth authorization handler",
	oauthCallback: "OAuth callback handler",
	providerCredentials: "Provider credential handler",
	providerAuthActions: "Provider auth action handler",
	scheduledAgents: "Scheduled agent handler",
	hookSettings: "Hook settings handler",
	hookExecution: "Hook execution handler",
	checkpoints: "Checkpoint handler",
	terminalActivity: "Terminal activity monitor",
	taskActivity: "Task activity monitor",
	partialState: "Partial state scheduler",
	sendLatency: "Send latency monitor",
	changeTracking: "Change tracking handler",
	providerModelCatalogs: "Provider model catalog handler",
	streamPublisher: "Webview stream publisher",
	sdkSettings: "SDK settings handler",
}

export class WebviewFeatureRegistry {
	private readonly values: Partial<WebviewFeatures> = {}
	private sealed = false

	attach<K extends keyof WebviewFeatures>(key: K, value: WebviewFeatures[K]) {
		if (this.sealed) throw new Error("WebView features are already configured.")
		this.values[key] = value
	}

	complete(features: RuntimeWebviewFeatures) {
		if (this.sealed) throw new Error("WebView features are already configured.")
		Object.assign(this.values, features)
		const missing = (Object.keys(labels) as Array<keyof WebviewFeatures>).filter((key) => !this.values[key])
		if (missing.length > 0) throw new Error(`WebView feature configuration is incomplete: ${missing.join(", ")}`)
		this.sealed = true
	}

	optional<K extends keyof WebviewFeatures>(key: K): WebviewFeatures[K] | null {
		return this.values[key] || null
	}

	require<K extends keyof WebviewFeatures>(key: K): WebviewFeatures[K] {
		const value = this.values[key]
		if (!value) throw new Error(`${labels[key]} is not attached.`)
		return value
	}
}
