import type { InteractionLoggerPort } from "../../application/ports/InteractionLoggerPort"
import { createToolPolicies, isStrictPlanModeBlockedTool, isWebFetchEnabled, webFetchDisabledReason } from "./ProviderConfiguration"

type ToolRuntimePolicyDependencies = {
	autoApprovalSettings: () => unknown
	browserSettings: () => unknown
	mode: () => "plan" | "act"
	strictPlanModeEnabled: () => boolean
	yoloMode: () => boolean
	writeWebToolState: (state: Record<string, unknown>) => void
	logger: InteractionLoggerPort
}

export class ToolRuntimePolicy {
	constructor(private readonly dependencies: ToolRuntimePolicyDependencies) {}

	currentPolicies() {
		const mode = this.dependencies.mode()
		const strictPlanModeEnabled = this.dependencies.strictPlanModeEnabled()
		const policies = createToolPolicies(this.dependencies.autoApprovalSettings(), this.dependencies.browserSettings(), mode, strictPlanModeEnabled, this.dependencies.yoloMode())
		if (mode === "plan") this.dependencies.logger.log("sidecar", "sdkModePolicy.plan", { strictPlanModeEnabled })
		return policies
	}

	isBlockedInCurrentMode(mappedToolName: string) {
		return this.dependencies.mode() === "plan" && this.dependencies.strictPlanModeEnabled() && isStrictPlanModeBlockedTool(mappedToolName)
	}

	refreshWebToolState() {
		const settings = this.dependencies.browserSettings()
		const enabled = isWebFetchEnabled(settings)
		this.dependencies.writeWebToolState({
			user: enabled,
			featureFlag: enabled,
			reason: webFetchDisabledReason(settings) || undefined,
		})
	}
}
