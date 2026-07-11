export type HookLifecycleName = "TaskStart" | "TaskResume" | "TaskCancel" | "TaskComplete" | "PreToolUse" | "PostToolUse" | "UserPromptSubmit"
export type HookSource = "global" | "workspace"
export type HookScript = Readonly<{ name: HookLifecycleName; source: HookSource; path: string; enabled: boolean }>
export type HookExecutionResult = { hook: HookScript; exitCode: number; stdout: string; stderr: string; error?: string; jsonResponse?: Record<string, unknown> }
