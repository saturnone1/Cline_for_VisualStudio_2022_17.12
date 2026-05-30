# VS2022 Cline SDK Coverage

This project now treats `@cline/sdk` as the runtime source of truth. The VSIX should provide host adapters and UI transport; it should not reimplement Cline's agent runtime in C#.

Reviewed against the public Cline SDK docs on 2026-05-30:

- https://docs.cline.bot/sdk/overview
- https://docs.cline.bot/sdk/reference/cline-core
- https://docs.cline.bot/sdk/tools
- https://docs.cline.bot/llms.txt

## Covered Through Cline SDK

- Session lifecycle: start, send, stop, get, update, delete.
- Session history and stored message reads.
- Token and cost usage through SDK accumulated usage.
- Tool approval routing through the SDK approval callback and the Cline webview approval buttons.
- Text streaming through SDK events mapped to webview partial messages, including SDK notice and iteration/status events.
- Rules, workflows, and skills through `core.settings.list()` and `core.settings.toggle()`.
- Checkpoint restore through `core.restore()` when the SDK session has checkpoint metadata.
- Built-in Cline tool execution delegated to the Visual Studio host adapter for workspace/editor/terminal operations.

## Current VSIX Implementation Snapshot

| Area | Status | Notes |
| --- | --- | --- |
| SDK runtime | Covered | The sidecar creates `ClineCore` with `backendMode: "local"` and uses SDK session APIs as the task authority. |
| WebView transport | Covered | WebView gRPC-style messages are routed to the sidecar; C# only provides startup hydration and host RPC. |
| Message streaming | Covered | SDK events are normalized into Cline WebView messages, including partial text, notice/iteration progress, task completion fallback, idle state separation, and terminal states. |
| Tool approval | Covered | SDK `requestToolApproval` is mapped to WebView approval UI and respects Visual Studio auto-approve settings. |
| Follow-up questions | Covered | SDK `ask_question` shows a WebView question, waits for option or freeform input, and removes the answered prompt. |
| File reads/searches | Covered | Host executors resolve paths inside Visual Studio workspace roots; automatic search/listing honors `.clineignore`. |
| File edits/apply_patch | Covered | SDK edits write through host adapters, snapshot before-content, emit compact change cards, and open VS diffs only on user review. |
| Commands | Partial | SDK `run_commands` executes through the Visual Studio command host with cancellation, but it is not yet a reusable integrated terminal session with background output tracking. |
| Checkpoints | Partial | SDK restore is wired when checkpoint run metadata exists; checkpoint diff/review parity is still limited. |
| Rules/workflows/skills settings | Partial | SDK settings can be listed/toggled, but the `skills` execution tool is disabled until approval and execution UX are complete. |
| MCP | Partial | MCP-related UI/state exists and MCP tool approval names are mapped, but marketplace/server lifecycle backends are not complete. |
| Browser/web fetch | Partial | `fetch_web_content` is disabled by default for air-gapped use and only enabled by `VSCLINE_ENABLE_WEB_FETCH=1`; full browser-session tooling needs a VSIX Chrome adapter. |
| Provider catalogs/OAuth | Partial | Local API configuration works for supported providers; remote catalog refresh and OAuth provider setup remain reduced. |
| Interaction diagnostics | Covered | Host, sidecar, WebView, user input, tool approvals, model/tool events, and responses are written to capped `%LOCALAPPDATA%\VsClineAgent\logs\interaction-*.jsonl` files. |

## Wrapper Boundary

The VSIX wrapper is now expected to stay inside these responsibilities:

- WebView2 tool window hosting.
- Node sidecar lifecycle and named-pipe JSON-RPC transport.
- Visual Studio host adapters for workspace, editor, terminal/process, diff, clipboard, status messages, external URI opening, storage, and secrets.
- External-system adapters that Visual Studio cannot provide directly, such as Chrome debugging, OAuth callback handling, and MCP process/config integration.

## Runtime Requirements

- `@cline/sdk` is the public SDK surface and re-exports `@cline/core`. The bundled SDK package currently requires Node.js 22 or later; the VSIX-bundled `Sidecar/node.exe` must stay on Node 22+.
- WebView2 Runtime is required before the Cline UI can render. On a connected machine, install it with:

  ```powershell
  winget install --id Microsoft.EdgeWebView2Runtime --source winget
  ```

- For air-gapped machines, do not depend on the online Evergreen installer and do not copy an installed Evergreen folder from `Program Files\Microsoft\EdgeWebView\Application\<version>`. Bundle the official WebView2 Fixed Version Runtime CAB into the VSIX before building:

  ```powershell
  .\scripts\Bundle-WebView2Runtime.ps1 -SourceCab "D:\offline\Microsoft.WebView2.FixedVersionRuntime.<version>.x64.cab"
  ```

  Or pass an explicit extracted runtime folder:

  ```powershell
  .\scripts\Bundle-WebView2Runtime.ps1 -SourceRuntime "D:\offline\Microsoft.WebView2.FixedVersionRuntime.<version>.x64"
  ```

- The runtime must contain `msedgewebview2.exe` under either:

  ```text
  <VSIX install root>\WebView2Runtime\Microsoft.WebView2.FixedVersionRuntime.<version>.x64\msedgewebview2.exe
  %LOCALAPPDATA%\VsClineAgent\WebView2Runtime\Microsoft.WebView2.FixedVersionRuntime.<version>.x64\msedgewebview2.exe
  ```

- The Cline SDK Node dependency tree is packaged as `Sidecar/node_modules.zip` and expanded on first run to `%LOCALAPPDATA%\VsClineAgent\Sidecar\1.0.0`. This avoids VSIX Installer path-depth failures while keeping the wrapper focused on hosting the SDK.

## SDK Contract Review Notes

- `ClineCore.start()` expects a `CoreSessionConfig` plus optional `userImages`, `userFiles`, `toolPolicies`, and per-session `capabilities`. The VS wrapper now passes `workspaceRoot` alongside `cwd` and sends WebView attachments through SDK fields instead of embedding them only in prompt text.
- Tool policy entries must explicitly cover every SDK default tool because SDK tools without a policy default to enabled and auto-approved. `read_files`, `search_codebase`, `run_commands`, `editor`, `apply_patch`, `ask_question`, and `submit_and_exit` are backed by VS host or SDK executors. `fetch_web_content` is disabled by default for air-gapped use unless `VSCLINE_ENABLE_WEB_FETCH=1` is set. `skills` is explicitly disabled until the VS wrapper has a real skills executor/approval UX.
- Visual Studio workspace listing and search must honor project `.clineignore` for automatic context gathering. Explicit file reads are still allowed, matching Cline's documented behavior for direct user references.
- SDK `ask_question` is routed through the Cline WebView follow-up UI and waits for the user's response instead of auto-selecting an option. After the user answers, the active choice prompt is removed from state so the same option cannot be clicked again; freeform chat input is also accepted as the pending question answer.
- SDK tool cancellation is bridged for `run_commands`: the executor observes `AgentToolContext.abortSignal` and asks the Visual Studio host to terminate active command processes on task stop/cancel.
- SDK session identity is host-owned: each WebView task id is passed as `CoreSessionConfig.sessionId`, and incoming SDK events are ignored unless their `payload.sessionId` matches the active/current task. This keeps `send`, `abort`, `restore`, approvals, history, and late event routing on the same session instead of mixing stale or SDK-generated ids.
- SDK file and command tools validate paths at the sidecar boundary. `read_files`, `search_codebase`, `run_commands` cwd, and `editor` paths must resolve inside the open Visual Studio workspace roots.
- SDK editor and `apply_patch` writes are tracked at the sidecar boundary: before-content snapshots are stored under `%LOCALAPPDATA%\VsClineAgent\changes`, line additions/deletions are surfaced in a compact Cline tool-window change card, and Visual Studio `Tools.DiffFiles` is opened only when the user chooses a file to review.
- SDK sessions do not receive wrapper-owned conversation-flow limits by default. `maxIterations`, `maxParallelToolCalls`, `maxTokensPerTurn`, `apiTimeoutMs`, `execution.maxConsecutiveMistakes`, `execution.reminderAfterIterations`, and `execution.loopDetection` are only sent when explicitly configured through API settings or environment variables (`VSCLINE_MAX_ITERATIONS`, `VSCLINE_MAX_PARALLEL_TOOL_CALLS`, `VSCLINE_MAX_TOKENS_PER_TURN`, `VSCLINE_API_TIMEOUT_MS`, `VSCLINE_MAX_CONSECUTIVE_MISTAKES`, `VSCLINE_REMINDER_AFTER_ITERATIONS`, `VSCLINE_LOOP_DETECTION`, `VSCLINE_LOOP_SOFT_THRESHOLD`, `VSCLINE_LOOP_HARD_THRESHOLD`). This keeps Cline SDK's own runtime semantics authoritative unless the user opts into a host policy.
- SDK `abort()` is treated as an in-flight operation cancel, not a session stop. The VS wrapper keeps the active session id after Cancel so the user can continue the same conversation; `stop()` remains the only session-ending path.
- SDK tool approvals and follow-up questions now wait on the SDK/user flow instead of a wrapper-owned timeout. The wrapper only resolves an outstanding request when the user answers, cancels, or a newer SDK request supersedes it.
- WebView follow-up messages are sent only to the SDK's current `activeSessionId`. The wrapper no longer falls back to a completed `currentTaskItem.id`, which avoided stale `session not found` errors after a task had already ended.
- SDK `status: idle` is not treated as task progress. It clears VS wrapper idle/status notices without adding artificial `api_req_started` rows, so an idle notification from SDK does not by itself keep the UI in a fake Thinking state.
- SDK event coverage now includes `chunk`, `session_snapshot`, `team_progress`, `hook`, `pending_prompts`, and `pending_prompt_submitted` in addition to `agent_event`, `status`, and `ended`. `AgentEvent` coverage includes `content_update`, `iteration_start`, `iteration_end`, and `notice` events in addition to `content_start`, `content_end`, `usage`, `done`, and `error`. `chunk` events are treated as low-level activity/output streams; `stream: "agent"` chunks are normalized into visible transcript rows so live sessions show the same assistant reasoning, tool calls, and tool results that are available when reopening a persisted SDK session.
- SDK tool call and tool result transcript rows are normalized for readability. Tool inputs prefer command, file, search, path, or patch summaries; tool results prefer command output summaries or pretty JSON instead of unreadable escaped one-line blobs.
- SDK `AgentEvent.content_start` text/reasoning fragments are not full-state changes. Text fragments are routed through `UiService.subscribeToPartialMessage`, reasoning fragments update bounded status at intervals, and full `StateService.subscribeToState` hydration is reserved for real state transitions such as tool calls, approvals, notices, usage, completion, and errors. This avoids repeatedly serializing the full `stateJson` for every token and keeps long SDK sessions from exhausting the Node sidecar heap.
- WebView state subscriptions now refresh SDK history and the selected persisted session before sending initial hydration. During live assistant text streaming, the wrapper still uses partial-message updates for token-level UI, but also sends throttled full-state snapshots so the visible chat stays current even if the WebView misses or recreates a partial-message subscription.
- Diagnostic logging now records compact SDK/WebView message summaries instead of full accumulated assistant text, state JSON, or raw chunk payloads. This avoids turning long Cline sessions into large in-memory/log payloads while preserving event type, session id, text length, and previews for debugging.
- Windows command execution normalizes slash-separated relative path arguments before sending commands to `cmd.exe`, because built-in commands such as `dir` interpret `/Controllers` as an option rather than a path. The injected SDK system prompt also reminds the model that Visual Studio command execution uses Windows `cmd.exe`.
- Provider ids sent by the WebApp may arrive as proto enum names such as `OLLAMA`; the wrapper normalizes those to SDK provider ids such as `ollama` before persisting or starting sessions.
- Settings hydration is intentionally duplicated at the boundary: C# sends a safe initial state so React can render even if sidecar streaming is late, while the sidecar remains the authoritative state stream and persistence owner.
- The Cline SDK docs list MCPs, checkpoints, web fetch, cron/scheduled agents, subagents, and plugins as SDK capabilities. This VSIX only marks those as covered when a Visual Studio host adapter and WebView UX exist; SDK availability alone is not treated as Visual Studio parity.

The VSIX wrapper should not own these responsibilities:

- Agent loop/runtime semantics.
- Prompt generation and assistant-message parsing.
- Cline tool semantics.
- Provider/model registry behavior.
- Session, history, checkpoint, or message persistence.

The legacy C# runtime path (`Agent/*`, `Bridge/VisualStudioClineBridge.cs`, `SettingsService`, `AgentSettings`) has been removed from the VSIX compile path. Those files may remain in the repository as historical reference, but the shipped extension should route WebView requests through the sidecar SDK path.

## Partially Covered

- MCP: SDK settings can enumerate/toggle MCP-related items, but the VSIX does not yet expose a full MCP marketplace/server management backend.
- Browser tools: SDK can request browser/web tool use, but Visual Studio 2022 has no VS Code browser-session integration; this needs a VSIX-owned Chrome debugging adapter.
- Provider/model discovery: API configuration is passed to SDK sessions, but provider catalog refresh and OAuth-backed provider setup are not full upstream parity.
- Account/auth: unauthenticated snapshots are supported, but VS Code authentication-provider flows are not available in Visual Studio 2022.
- Subagents/teams: SDK runtime support exists, but the VSIX UI/host mapping is still reduced.
- Hooks: SDK settings can surface hook-related configuration, but VSIX host lifecycle hook execution is not fully mapped.
- Scheduled agents/cron automation: Cline SDK exposes automation APIs when enabled, but the VSIX does not currently run a scheduler or automation service.
- Plugins/extensions: the SDK supports plugins and custom tools, but the VSIX does not yet expose a plugin install/configuration surface.

## Not Directly Portable To Visual Studio 2022 17.12

- VS Code terminal shell integration: Visual Studio exposes a different terminal and process automation model. A VS-specific terminal manager is required.
- VS Code command IDs and contribution points: worktree, editor, diff, account, and command palette flows need Visual Studio command replacements.
- VS Code authentication providers: Visual Studio 2022 does not expose the same extension auth provider API. OAuth callback flows must be implemented by the VSIX/sidecar.
- VS Code webview URI helpers: WebView2 resource loading must use VSIX-packaged assets and host mediation.
- VS Code diff/comment UI: Visual Studio diff and editor APIs differ; inline diff comments and checkpoint review need a VS-specific adapter.
- Extension host storage/secrets APIs: persistent storage and secrets must be mapped to Visual Studio settings, Windows credential storage, or sidecar storage.

## UI Policy

The WebView should show SDK-owned features as available, partial, or blocked by Visual Studio host limits. It should avoid exposing controls that only return fake success. If a feature cannot be implemented by Visual Studio 2022 directly, the UI should either:

- route to a real VSIX/sidecar adapter, or
- show it as a Visual Studio limitation and keep the action disabled/reduced.

## Remaining Work

1. Finish eliminating C# runtime fallback behavior: `VisualStudioClineBridge` should remain only a transport/safe-hydration fallback, not an alternate agent runtime.
2. Build a VS-specific terminal manager with reusable terminal sessions, bounded output streaming, cancellation, background command tracking, and clearer command display.
3. Complete review UX for file changes: group edits are now shown in the tool window, but undo/revert and multi-file review actions still need first-class buttons.
4. Add a Chrome debugging browser adapter for SDK browser/web actions.
5. Implement real MCP server and marketplace service handlers on top of SDK/core MCP capabilities.
6. Implement OAuth/account callback handling outside VS Code auth providers.
7. Complete SDK checkpoint parity: restore is wired for SDK checkpoint metadata, but checkpoint diff/review buttons still need deeper SDK metadata mapping.
8. Decide whether scheduled agents, plugins, and subagents should be exposed in the Visual Studio UI or explicitly hidden as unsupported features.
