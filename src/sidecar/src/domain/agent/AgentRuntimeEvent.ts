export type AgentEventPayload = Readonly<Record<string, unknown>>

export type AgentEvent =
	| { type: "AgentStarted"; sessionId: string; iteration?: number; raw: AgentEventPayload }
	| { type: "TextDelta"; sessionId: string; text: string; accumulated: string; phase: "start" | "update" | "end"; raw: AgentEventPayload }
	| { type: "ReasoningDelta"; sessionId: string; text: string; phase: "start" | "update" | "end"; raw: AgentEventPayload }
	| { type: "ToolCallRequested"; sessionId: string; toolName: string; input: unknown; raw: AgentEventPayload }
	| { type: "ToolCallCompleted"; sessionId: string; toolName: string; input: unknown; output: unknown; error: string; iteration?: number; raw: AgentEventPayload }
	| { type: "ToolCallUpdated"; sessionId: string; toolName: string; update: unknown; raw: AgentEventPayload }
	| { type: "IterationCompleted"; sessionId: string; iteration?: number; toolCallCount: number; hadToolCalls: boolean; raw: AgentEventPayload }
	| { type: "NoticeReceived"; sessionId: string; message: string; reason: string; noticeType: string; raw: AgentEventPayload }
	| { type: "ToolFinished"; sessionId: string; toolCall: AgentEventPayload; result: AgentEventPayload; message: unknown; raw: AgentEventPayload }
	| { type: "AssistantMessageReceived"; sessionId: string; message: AgentEventPayload; raw: AgentEventPayload }
	| { type: "RunFinished"; sessionId: string; result: AgentEventPayload; usage: AgentEventPayload; completion: AgentEventPayload; raw: AgentEventPayload }
	| { type: "RunFailed"; sessionId: string; reason: string; raw: AgentEventPayload }
	| { type: "UsageUpdated"; sessionId: string; usage: AgentEventPayload; totalInputTokens?: number; totalOutputTokens?: number; totalCacheReadTokens?: number; totalCacheWriteTokens?: number; totalCost?: number; raw: AgentEventPayload }
	| { type: "AgentDone"; sessionId: string; result: AgentEventPayload; completion: AgentEventPayload; raw: AgentEventPayload }
	| { type: "AgentError"; sessionId: string; error: unknown; raw: AgentEventPayload }
	| { type: "ApprovalRequested"; sessionId: string; toolName: string; input: AgentEventPayload; raw: AgentEventPayload }
	| { type: "AgentCompleted"; sessionId: string; reason: string; raw: AgentEventPayload }
	| { type: "AgentFailed"; sessionId: string; reason: string; raw: AgentEventPayload }
	| { type: "AgentEventUnknown"; sessionId: string; originalType: string; raw: AgentEventPayload }

export type ApprovalRequestedEvent = Extract<AgentEvent, { type: "ApprovalRequested" }>

export type AgentChunkRuntimeEvent = { type: "chunk"; sessionId: string; stream: string; chunk: unknown; payload: AgentEventPayload }
export type SessionSnapshotRuntimeEvent = { type: "session_snapshot"; sessionId: string; status: string; modelId: string; usage: AgentEventPayload; payload: AgentEventPayload }
export type TeamProgressRuntimeEvent = { type: "team_progress"; sessionId: string; message: string; teamId: string; teamName: string; phase: string; status: string; agents: ReadonlyArray<{ id: string; name: string; status: string; progress?: number }>; results: ReadonlyArray<{ id: string; status: string; summary: string }>; payload: AgentEventPayload }
export type HookRuntimeEvent = { type: "hook"; sessionId: string; hookEventName: string; toolName: string; agentId: string; conversationId: string; iteration?: number; payload: AgentEventPayload }
export type PendingPromptsRuntimeEvent = { type: "pending_prompts"; sessionId: string; count: number; payload: AgentEventPayload }
export type PendingPromptSubmittedRuntimeEvent = { type: "pending_prompt_submitted"; sessionId: string; prompt: string; payload: AgentEventPayload }

export type AgentRuntimeEvent =
	| { type: "agent_event"; sessionId: string; event: AgentEvent; payload: AgentEventPayload }
	| { type: "vscline_file_changed"; payload: AgentEventPayload }
	| AgentChunkRuntimeEvent
	| SessionSnapshotRuntimeEvent
	| TeamProgressRuntimeEvent
	| HookRuntimeEvent
	| PendingPromptsRuntimeEvent
	| PendingPromptSubmittedRuntimeEvent
	| { type: "status"; sessionId: string; status: string; lifecycle: AgentEvent; payload: AgentEventPayload }
	| { type: "ended"; sessionId: string; reason: string; lifecycle: AgentEvent; payload: AgentEventPayload }
	| { type: "unknown"; originalType: string; payload: AgentEventPayload }
