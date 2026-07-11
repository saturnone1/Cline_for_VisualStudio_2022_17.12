import type { AgentRuntimeEvent, HookRuntimeEvent, PendingPromptSubmittedRuntimeEvent, PendingPromptsRuntimeEvent, TeamProgressRuntimeEvent } from "../../domain/agent/AgentRuntimeEvent"

type Callbacks = Readonly<{
	noteActivity: (reason: string) => void
	addMessage: (message: Record<string, unknown>) => void
	updateTask: () => void
	broadcast: () => void
	log: (event: string, details: Record<string, unknown>) => void
}>

export class AgentAuxiliaryEventProjector {
	constructor(private readonly callbacks: Callbacks) {}

	handle(event: AgentRuntimeEvent) {
		switch (event.type) {
			case "team_progress": this.team(event); return true
			case "hook": this.hook(event); return true
			case "pending_prompts": this.pending(event); return true
			case "pending_prompt_submitted": this.submitted(event); return true
			default: return false
		}
	}

	private team(event: TeamProgressRuntimeEvent) {
		this.callbacks.noteActivity("team_progress")
		this.callbacks.addMessage({ type: "say", say: "use_subagents", text: JSON.stringify({ message: event.message, teamId: event.teamId || undefined, teamName: event.teamName || undefined, phase: event.phase || undefined, status: event.status || undefined, agents: event.agents.map((agent) => ({ ...agent })), results: event.results.map((result) => ({ ...result, summary: truncate(result.summary, 500) })) }), isCollapsed: true, isExpanded: false })
		this.callbacks.log("teamProgress", { message: truncate(event.message, 500), agents: event.agents.length, results: event.results.length })
		this.finish()
	}

	private hook(event: HookRuntimeEvent) {
		this.callbacks.noteActivity(`hook:${event.hookEventName || "unknown"}`)
		this.callbacks.addMessage({ type: "say", say: "hook_status", text: JSON.stringify({ hookEventName: event.hookEventName, toolName: event.toolName, agentId: event.agentId || undefined, conversationId: event.conversationId || undefined, iteration: event.iteration }) })
		this.finish()
	}

	private pending(event: PendingPromptsRuntimeEvent) {
		this.callbacks.noteActivity("pending_prompts")
		if (event.count > 0) this.callbacks.log("pendingPrompts", { count: event.count })
		this.finish()
	}

	private submitted(event: PendingPromptSubmittedRuntimeEvent) {
		this.callbacks.noteActivity("pending_prompt_submitted")
		if (event.prompt) this.callbacks.log("pendingPromptSubmitted", { prompt: truncate(event.prompt, 160) })
		this.finish()
	}

	private finish() { this.callbacks.updateTask(); this.callbacks.broadcast() }
}

function truncate(value: string, maxChars: number) { return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n\n[truncated ${value.length - maxChars} chars]` }
