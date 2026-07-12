import type { InteractionLoggerPort } from "../../application/ports/InteractionLoggerPort"
import type { WindowPort } from "../../application/ports/HostProviderPort"
import { getCommandText, getPatchPathsFromUnknown, getSearchQuery, getToolPathFromUnknown } from "../conversation/ConversationSupport"
import { stringify } from "../webview/RuntimeErrorFormatter"

export class AutoApprovalNotifier {
	constructor(private readonly window: WindowPort, private readonly logger: InteractionLoggerPort) {}

	async notify(enabled: boolean, mappedToolName: string, input: Record<string, unknown>) {
		if (!enabled) return
		const detail = mappedToolName === "executeCommand"
			? getCommandText(input)
			: getPatchPathsFromUnknown(input) || getToolPathFromUnknown(input) || getSearchQuery(input)
		const suffix = detail ? `: ${truncate(detail, 120)}` : ""
		try {
			await this.window.showMessage({ message: `LIG VS auto-approved ${mappedToolName}${suffix}`, type: "info" })
		} catch (error) {
			this.logger.log("sidecar", "autoApproveNotificationFailed", { error: stringify(error) })
		}
	}
}

function truncate(value: string, maxLength: number) {
	const normalized = value.replace(/\s+/g, " ").trim()
	return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}...`
}
