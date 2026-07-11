import type { InteractionLoggerPort } from "../../application/ports/InteractionLoggerPort"
import type { WorkspacePort } from "../../application/ports/HostProviderPort"
import { buildTerminalActivityText } from "./ConversationSupport"

export class TerminalActivityMonitor {
	private timer: NodeJS.Timeout | null = null
	private polling = false
	private lastOutputSequence = 0

	constructor(private readonly workspace: WorkspacePort, private readonly logger: InteractionLoggerPort, private readonly onActivity: (text: string) => void, private readonly language: () => "en" | "ko", private readonly pollIntervalMs = readPositiveIntEnv("VSCLINE_TERMINAL_STATE_POLL_MS", 2500)) {}

	get isActive() { return this.timer !== null }
	start() { if (!this.timer) { this.pollSafely(); this.timer = setInterval(() => this.pollSafely(), this.pollIntervalMs) } }
	stop() { if (this.timer) clearInterval(this.timer); this.timer = null; this.polling = false }
	async poll() {
		if (this.polling) return
		this.polling = true
		try {
			const state = asRecord(await this.workspace.getTerminalState({}))
			const output = asRecord(await this.workspace.getUnretrievedTerminalOutput({ afterSequence: this.lastOutputSequence }))
			const lines = records(output.lines)
			for (const line of lines) this.lastOutputSequence = Math.max(this.lastOutputSequence, readNumber(line.sequence) || 0)
			const text = buildTerminalActivityText(records(state.activeCommands), records(state.recentCommands), lines, state, this.language())
			if (text) this.onActivity(text)
		} finally { this.polling = false }
	}
	dispose() { this.stop() }
	private pollSafely() { this.poll().catch((error) => this.logger.log("sidecar", "terminalStatePollFailed", { message: error instanceof Error ? error.message : String(error) })) }
}

function records(value: unknown) { return Array.isArray(value) ? value.map(asRecord) : [] }
function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function readNumber(value: unknown) { const number = Number(value); return Number.isFinite(number) ? number : undefined }
function readPositiveIntEnv(name: string, fallback: number) { const value = Number(process.env[name]); return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback }
