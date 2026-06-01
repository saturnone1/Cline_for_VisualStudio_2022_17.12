# VS2022 Cline SDK Coverage

This project now treats `@cline/sdk` as the runtime source of truth. The VSIX should provide host adapters and UI transport; it should not reimplement Cline's agent runtime in C#.

Reviewed against the public Cline SDK docs on 2026-05-30:

- https://docs.cline.bot/sdk/overview
- https://docs.cline.bot/sdk/reference/cline-core
- https://docs.cline.bot/sdk/tools
- https://docs.cline.bot/llms.txt

## Documentation Map

This file is the canonical implementation and parity tracker for the Visual
Studio 2022 Cline port.

- `VS2022-SDK-COVERAGE.md`: current SDK coverage, parity gaps, and active
  implementation order.
- `PORT-FIDELITY-GAPS.md`: archived pointer to this document. Older C# bridge
  audit notes were removed because they described the pre-SDK runtime path.
- `PORT-ARCHITECTURE-PLAN.md`: historical architecture direction for moving to
  a Node sidecar and Visual Studio host adapter.
- `UPSTREAM_BASELINE.md`: upstream baseline and packaging notes.
- `AIR-GAP-BUILD.md`: offline/runtime packaging instructions.
- `CLAUDE.md`: local assistant/development notes.
- `sidecar/README.md`: sidecar development commands and runtime layout.
- `webview-ui/src/components/settings/README.md`: settings UI component notes.
- `webview-ui/src/components/mcp/RICH_MCP_TESTING.md`: MCP UI testing notes.

When adding new parity findings, update this file first. Other Markdown files
should either link here or document build/architecture details that do not
belong in the active feature matrix.

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
| Message streaming | Covered | SDK events are normalized into Cline WebView messages. Final assistant Markdown is rendered only from terminal text events; coherent live reasoning narration is kept in a collapsed progress row so intermediate model activity remains readable on demand without appearing as main chat output. |
| Tool approval | Covered | SDK `requestToolApproval` is mapped to WebView approval UI and respects Visual Studio auto-approve settings. |
| Follow-up questions | Covered | SDK `ask_question` shows a WebView question, waits for option or freeform input, and removes the answered prompt. |
| File reads/searches | Covered | Host executors resolve paths inside Visual Studio workspace roots; automatic search/listing honors `.clineignore`. |
| File edits/apply_patch | Covered | SDK edits write through host adapters, snapshot before-content, emit compact change cards, and open VS diffs only on user review. |
| Commands | Partial | SDK `run_commands` executes through reusable Visual Studio command-host shell sessions with command ids, terminal ids, UTF-8 codepage setup, bounded output retention, cancellation, active-command state, hot/background command detection, and recent/unretrieved output RPCs. It is still not a first-class Visual Studio terminal pane integration. |
| Checkpoints | Partial | SDK restore is wired when checkpoint run metadata exists; checkpoint diff/review parity is still limited. |
| Rules/workflows/skills settings | Partial | SDK settings can be listed/toggled, but the `skills` execution tool is disabled until approval and execution UX are complete. |
| MCP | Partial | SDK `InMemoryMcpManager` is wired for settings-file server registration, list, connect/tool discovery, add remote server, toggle, timeout, restart, delete, and per-tool auto-approve metadata. Marketplace install and OAuth callback flows remain reduced. |
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
- SDK tool cancellation is bridged for `run_commands`: the executor observes `AgentToolContext.abortSignal` and asks the Visual Studio host to terminate active command processes on task stop/cancel. Command execution now returns `commandId`, `terminalId`, duration, truncation flags, and bounded stdout/stderr so the WebView and diagnostics can distinguish a command run from an anonymous one-shot blob.
- SDK session identity is host-owned: each WebView task id is passed as `CoreSessionConfig.sessionId`, and incoming SDK events are ignored unless their `payload.sessionId` matches the active/current task. This keeps `send`, `abort`, `restore`, approvals, history, and late event routing on the same session instead of mixing stale or SDK-generated ids.
- SDK file and command tools validate paths at the sidecar boundary. `read_files`, `search_codebase`, `run_commands` cwd, and `editor` paths must resolve inside the open Visual Studio workspace roots.
- SDK editor and `apply_patch` writes are tracked at the sidecar boundary: before-content snapshots are stored under `%LOCALAPPDATA%\VsClineAgent\changes`, line additions/deletions are surfaced in a compact Cline tool-window change card, and Visual Studio `Tools.DiffFiles` is opened only when the user chooses a file to review.
- SDK sessions do not receive wrapper-owned conversation-flow limits by default. `maxIterations`, `maxParallelToolCalls`, `maxTokensPerTurn`, `apiTimeoutMs`, `execution.maxConsecutiveMistakes`, `execution.reminderAfterIterations`, and `execution.loopDetection` are only sent when explicitly configured through API settings or environment variables (`VSCLINE_MAX_ITERATIONS`, `VSCLINE_MAX_PARALLEL_TOOL_CALLS`, `VSCLINE_MAX_TOKENS_PER_TURN`, `VSCLINE_API_TIMEOUT_MS`, `VSCLINE_MAX_CONSECUTIVE_MISTAKES`, `VSCLINE_REMINDER_AFTER_ITERATIONS`, `VSCLINE_LOOP_DETECTION`, `VSCLINE_LOOP_SOFT_THRESHOLD`, `VSCLINE_LOOP_HARD_THRESHOLD`). This keeps Cline SDK's own runtime semantics authoritative unless the user opts into a host policy.
- SDK `abort()` is treated as an in-flight operation cancel, not a session stop. The VS wrapper keeps the active session id after Cancel so the user can continue the same conversation; `stop()` remains the only explicit session-ending path.
- SDK completion is treated as the end of a turn, not as the end of the open chat. The wrapper no longer marks the SDK session inactive after `done`/completion, and follow-up chat input is sent to the current task session instead of creating a new task while the user keeps the tool window conversation open.
- SDK tool approvals and follow-up questions now wait on the SDK/user flow instead of a wrapper-owned timeout. The wrapper only resolves an outstanding request when the user answers, cancels, or a newer SDK request supersedes it.
- WebView follow-up messages prefer the SDK's current `activeSessionId` and otherwise continue the still-open current task session while the tool window conversation remains open. Completed turns are not treated as closed conversations unless the user closes/deletes the task.
- SDK `status: idle` is not treated as task progress. It clears VS wrapper idle/status notices without adding artificial `api_req_started` rows, so an idle notification from SDK does not by itself keep the UI in a fake Thinking state.
- SDK event coverage now includes `chunk`, `session_snapshot`, `team_progress`, `hook`, `pending_prompts`, and `pending_prompt_submitted` in addition to `agent_event`, `status`, and `ended`. `AgentEvent` coverage includes `content_update`, `iteration_start`, `iteration_end`, and `notice` events in addition to `content_start`, `content_end`, `usage`, `done`, and `error`. `chunk` events are treated as low-level activity/output streams; `stream: "agent"` chunks expose explicit tool transcripts and fold live text/reasoning deltas into collapsed progress rows instead of rendering raw model scratch text in the main chat.
- SDK tool call and tool result transcript rows are normalized for readability. Tool inputs prefer command, file, search, path, or patch summaries; tool results prefer command output summaries or pretty JSON instead of unreadable escaped one-line blobs.
- SDK file/search/edit tool progress is grouped into one collapsed live tool row while a turn is running. This prevents repeated `Cline read 1 file` rows and keeps the single collapsed `Thinking` row at the bottom until final assistant Markdown arrives.
- SDK internal bookkeeping events such as `iteration_start`, `iteration_end`, `usage`, and `done` are not rendered as chat transcript rows. Mixed raw agent chunks that begin with those event envelopes are filtered so tokenized reasoning fragments do not appear as one-word-per-line chat output.
- Short plain `stream: "agent"` fragments are treated as SDK/model reasoning noise unless they are explicit tool transcript rows. Tokenized reasoning is dropped, while coherent reasoning narration is stored as a collapsed `REASONING` transcript row instead of being expanded into the main chat.
- Structured `content_start`, `content_update`, `content_delta`, and `content_end` records embedded inside raw `stream: "agent"` chunks are split by content type. Only terminal text records are eligible for main transcript rendering; in-flight text/reasoning records are collapsed so final assistant Markdown remains visible without exposing internal token streams.
- SDK `AgentEvent.content_start` / `content_update` text and reasoning fragments are not rendered as chat answers. Only fragments that look like coherent reasoning narration update the collapsed reasoning row; ordinary in-flight text waits for the terminal text event before rendering. Full `StateService.subscribeToState` hydration is reserved for real state transitions such as tool calls, approvals, notices, usage, completion, and errors. This avoids repeatedly serializing the full `stateJson` for every token and keeps long SDK sessions from exhausting the Node sidecar heap.
- WebView state subscriptions now refresh SDK history and the selected persisted session before sending initial hydration. Partial-message streaming follows upstream Cline semantics: the sidecar must first create the row through full state hydration, and `subscribeToPartialMessage` may only replace an existing message by `ts`. The WebView intentionally ignores orphan partials instead of appending them, preventing live-only rows from flickering, disappearing, or diverging after session reopen.
- Persisted session re-entry uses SDK `readMessages(sessionId)` as the transcript source of truth. The wrapper no longer merges sidecar-local progress rows into reopened sessions, and SDK messages receive deterministic timestamps derived from SDK message metadata or the session id so the same session hydrates to the same rows across close/reopen cycles.
- SDK `readMessages(sessionId)` hydration now treats SDK `Tool result:` / `tool_use` / `tool_result` content as collapsed tool/activity history instead of user feedback. Repeated placeholder-only progress rows are omitted, coherent model reasoning is merged into one collapsed reasoning record, and final assistant Markdown remains a normal visible transcript row.
- Common WebView RPCs that are not backed by a full Visual Studio service yet are now explicitly handled by the sidecar as reduced/no-op responses rather than falling through to transport errors. This includes file helper probes, provider catalog refreshes, and WorktreeService stubs. MCP server management now routes through the SDK MCP manager where SDK support exists.
- MCP server state is backed by SDK/core MCP APIs. The sidecar uses `resolveDefaultMcpSettingsPath`, `loadMcpSettingsFile`, `registerMcpServersFromSettingsFile`, `InMemoryMcpManager`, `createDefaultMcpServerClientFactory`, and `createMcpTools`; enabled MCP server tools are passed into each SDK session as `extraTools`.
- WebView history preview now always mounts on the welcome screen and asks `TaskService.getTaskHistory` instead of relying only on the first state snapshot, so the first screen can show saved sessions even before a full sidecar state refresh arrives.
- WebView chat layout keeps the main transcript scrollbar visible, separates scroll affordances from task action buttons, and only binds Escape to Cancel when the active button state is actually cancellable.
- WebView reasoning lookup reads the SDK-normalized `reasoning` field as well as legacy `text`, so collapsed progress rows keep their contents after regrouping or reopening a session.
- WebView2 runtime discovery/copy and Cline sidecar runtime preparation run after the loading panel is rendered and are dispatched off the Visual Studio UI thread. This keeps first-run Fixed Runtime copy and `node_modules.zip` extraction from freezing the IDE.
- Diagnostic logging now records compact SDK/WebView message summaries instead of full accumulated assistant text, state JSON, or raw chunk payloads. This avoids turning long Cline sessions into large in-memory/log payloads while preserving event type, session id, text length, and previews for debugging.
- Windows command execution normalizes slash-separated relative path arguments before sending commands to `cmd.exe`, because built-in commands such as `dir` interpret `/Controllers` as an option rather than a path. The injected SDK system prompt also reminds the model that Visual Studio command execution uses Windows `cmd.exe`.
- The Visual Studio command host keeps lightweight reusable `cmd.exe` shell sessions per workspace, active/background command state, hot-process detection, and a capped recent-output buffer exposed through `workspace.getTerminalState` and `workspace.getUnretrievedTerminalOutput`. This is the first VS-specific terminal-manager layer; future work still needs deeper Visual Studio terminal-pane integration and richer shell state inspection.
- WebView command output rows render as collapsed Visual Studio command cards instead of raw Markdown blobs. Completed command cards show command count, command id, terminal id, exit code, duration, bounded stdout/stderr, and truncation markers so users can inspect command activity without reopening diagnostics.
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

- MCP: SDK settings-file servers can be listed, connected, added, toggled, restarted, deleted, timed out, and surfaced as SDK `extraTools`; marketplace install and OAuth callback UX are not full upstream parity.
- Browser tools: SDK can request browser/web tool use, but Visual Studio 2022 has no VS Code browser-session integration; this needs a VSIX-owned Chrome debugging adapter.
- Provider/model discovery: API configuration is passed to SDK sessions, but provider catalog refresh and OAuth-backed provider setup are not full upstream parity.
- Account/auth: unauthenticated snapshots are supported, but VS Code authentication-provider flows are not available in Visual Studio 2022.
- Subagents/teams: SDK runtime support exists, but the VSIX UI/host mapping is still reduced.
- Hooks: SDK settings can surface hook-related configuration, but VSIX host lifecycle hook execution is not fully mapped.
- Scheduled agents/cron automation: Cline SDK exposes automation APIs when enabled, but the VSIX does not currently run a scheduler or automation service.
- Plugins/extensions: the SDK supports plugins and custom tools, but the VSIX does not yet expose a plugin install/configuration surface.

## Visual Studio Parity Backlog

These are the active porting tracks. "Next step" should refer to this order
unless a user report requires an urgent bug fix.

### 1. Terminal and Command Execution

Status: Partial, active.

Current behavior:

- Commands run through the Visual Studio command host adapter.
- Reusable `cmd.exe` shell sessions are retained per workspace so sequential
  commands can reuse shell state instead of spawning only one-shot `cmd.exe /c`
  processes.
- Command ids, terminal ids, UTF-8 codepage setup, bounded output retention,
  cancellation, active/background-command state, recent output, and
  unretrieved-output RPCs exist.
- Hot/long-running commands such as `dotnet watch`, `npm run dev`, and common
  dev servers are kept as background commands instead of being killed on the
  normal command timeout.
- WebView command rows render as collapsed Visual Studio command cards.

Remaining parity:

- Full "proceed while running" UX, including explicit continue/attach controls.
- Rich shell state tracking, including current directory and environment
  continuity beyond the lightweight command-host session.
- Better integration with Visual Studio terminal panes instead of only Output
  Window mirroring.

### 2. MCP Server and Marketplace Lifecycle

Status: Partial.

Remaining parity:

- Marketplace catalog loading/install flow.
- OAuth authenticate callback flow inside Visual Studio.
- Resource, resource-template, and prompt listing beyond SDK tool discovery.
- Deeper parity with upstream server lifecycle notifications and remote managed server policies.

### 3. Browser Tools

Status: Reduced.

Remaining parity:

- Chrome debugging adapter owned by the VSIX/sidecar.
- Session-based browser actions equivalent to upstream Cline.
- `fetch_web_content` enablement with clear offline/air-gap policy.
- Browser lifecycle and connection status surfaced in the WebView.

### 4. OAuth, Account, and Provider Auth

Status: Reduced or unsupported.

Remaining parity:

- Visual Studio compatible OAuth callback handling.
- OpenRouter, Requesty, Hicap, OpenAI Codex, and account login/logout flows.
- Auth state propagation into WebView account controls.
- Organization/credit/spend-limit workflows where applicable.

### 5. Checkpoint, Diff, Review, Undo/Revert

Status: Partial.

Remaining parity:

- First-class `Edited N files` cards with Review, Undo, and per-file expand.
- Multi-file review flow that opens VS diffs only when selected.
- Checkpoint restore/diff metadata closer to upstream `TaskCheckpointManager`.
- Checkpoint comment/explain UX that is visible in the task transcript.

### 6. Worktree

Status: Stub/reduced.

Remaining parity:

- Create, switch, merge, delete, include/exclude, and conflict flows.
- Visual Studio solution reload behavior when switching worktrees.
- WebView state and task routing per worktree.

### 7. Hooks, Scheduled Agents, Plugins, and Subagents

Status: Mostly not runtime-backed.

Remaining parity:

- Hook lifecycle execution for `PreToolUse`, `PostToolUse`, `TaskCancel`, and
  `TaskComplete`.
- Scheduled/cron agent runtime.
- Plugin install/configuration surface.
- Subagent/team execution surfaced with accurate progress and approval UX.

### 8. Provider and Model Catalog

Status: Partial.

Remaining parity:

- Provider-backed OpenRouter, LiteLLM, Vercel AI Gateway, and related catalog
  streams.
- Provider capability metadata and model refresh parity.
- Clear unsupported states instead of fake local catalog substitutions.

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

1. Continue the active Terminal and Command Execution track by adding richer
   Visual Studio terminal-pane integration and proceed-while-running controls on
   top of the reusable command-host session layer.
2. Keep `VisualStudioClineBridge` as transport/safe hydration only; do not add
   new alternate-agent runtime behavior there.
3. Complete review UX for file changes with undo/revert and multi-file review
   actions.
4. Add a Chrome debugging browser adapter for SDK browser/web actions.
5. Implement real MCP server and marketplace service handlers on top of
   SDK/core MCP capabilities.
6. Implement OAuth/account callback handling outside VS Code auth providers.
7. Complete SDK checkpoint parity by mapping deeper checkpoint diff/review
   metadata.
8. Decide whether scheduled agents, plugins, and subagents should be exposed in
   the Visual Studio UI or explicitly hidden as unsupported features.
