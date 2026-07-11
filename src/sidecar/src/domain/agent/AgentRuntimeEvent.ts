export type AgentEventPayload = Readonly<Record<string, unknown>>

export type AgentEvent =
	| { type: "AgentStarted"; sessionId: string; iteration?: number; raw: AgentEventPayload }
	| { type: "TextDelta"; sessionId: string; text: string; accumulated: string; phase: "start" | "update" | "end"; raw: AgentEventPayload }
	| { type: "ReasoningDelta"; sessionId: string; text: string; phase: "start" | "update" | "end"; raw: AgentEventPayload }
	| { type: "ToolCallRequested"; sessionId: string; toolName: string; input: unknown; raw: AgentEventPayload }
	| { type: "ToolCallCompleted"; sessionId: string; toolName: string; output: unknown; error: string; raw: AgentEventPayload }
	| { type: "ApprovalRequested"; sessionId: string; toolName: string; input: AgentEventPayload; raw: AgentEventPayload }
	| { type: "AgentCompleted"; sessionId: string; reason: string; raw: AgentEventPayload }
	| { type: "AgentFailed"; sessionId: string; reason: string; raw: AgentEventPayload }
	| { type: "AgentEventUnknown"; sessionId: string; originalType: string; raw: AgentEventPayload }

export type ApprovalRequestedEvent = Extract<AgentEvent, { type: "ApprovalRequested" }>

export type AgentRuntimeEvent =
	| { type: "agent_event"; sessionId: string; event: AgentEvent; payload: AgentEventPayload }
	| { type: "vscline_file_changed"; payload: AgentEventPayload }
	| { type: "chunk" | "session_snapshot" | "team_progress" | "hook" | "pending_prompts" | "pending_prompt_submitted"; sessionId: string; payload: AgentEventPayload }
	| { type: "status"; sessionId: string; status: string; lifecycle: AgentEvent; payload: AgentEventPayload }
	| { type: "ended"; sessionId: string; reason: string; lifecycle: AgentEvent; payload: AgentEventPayload }
	| { type: "unknown"; originalType: string; payload: AgentEventPayload }
