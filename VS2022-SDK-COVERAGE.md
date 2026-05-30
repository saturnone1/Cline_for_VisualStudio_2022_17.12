# VS2022 Cline SDK Coverage

This project now treats `@cline/sdk` as the runtime source of truth. The VSIX should provide host adapters and UI transport; it should not reimplement Cline's agent runtime in C#.

## Covered Through Cline SDK

- Session lifecycle: start, send, stop, get, update, delete.
- Session history and stored message reads.
- Token and cost usage through SDK accumulated usage.
- Tool approval routing through the SDK approval callback and the Cline webview approval buttons.
- Text streaming through SDK events mapped to webview partial messages.
- Rules, workflows, and skills through `core.settings.list()` and `core.settings.toggle()`.
- Checkpoint restore through `core.restore()` when the SDK session has checkpoint metadata.
- Built-in Cline tool execution delegated to the Visual Studio host adapter for workspace/editor/terminal operations.

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
- SDK file and command tools validate paths at the sidecar boundary. `read_files`, `search_codebase`, `run_commands` cwd, and `editor` paths must resolve inside the open Visual Studio workspace roots.
- SDK editor and `apply_patch` writes are tracked at the sidecar boundary: before-content snapshots are stored under `%LOCALAPPDATA%\VsClineAgent\changes`, line additions/deletions are surfaced in a compact Cline tool-window change card, and Visual Studio `Tools.DiffFiles` is opened only when the user chooses a file to review.
- SDK sessions apply production guardrails by default: `maxIterations=20`, `maxParallelToolCalls=4`, `maxTokensPerTurn=4096`, `apiTimeoutMs=180000`, `execution.maxConsecutiveMistakes=3`, `execution.reminderAfterIterations=6`, and `execution.loopDetection={ softThreshold: 3, hardThreshold: 5 }`. Override with `VSCLINE_MAX_ITERATIONS`, `VSCLINE_MAX_PARALLEL_TOOL_CALLS`, `VSCLINE_MAX_TOKENS_PER_TURN`, `VSCLINE_API_TIMEOUT_MS`, `VSCLINE_MAX_CONSECUTIVE_MISTAKES`, `VSCLINE_REMINDER_AFTER_ITERATIONS`, `VSCLINE_LOOP_DETECTION`, `VSCLINE_LOOP_SOFT_THRESHOLD`, and `VSCLINE_LOOP_HARD_THRESHOLD`.
- Provider ids sent by the WebApp may arrive as proto enum names such as `OLLAMA`; the wrapper normalizes those to SDK provider ids such as `ollama` before persisting or starting sessions.
- Settings hydration is intentionally duplicated at the boundary: C# sends a safe initial state so React can render even if sidecar streaming is late, while the sidecar remains the authoritative state stream and persistence owner.

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

1. Replace C# runtime fallback paths with sidecar SDK service handlers until `VisualStudioClineBridge` is only a transport fallback.
2. Build a VS-specific terminal manager with reusable terminal sessions, output streaming, cancellation, and background command tracking.
3. Add a Chrome debugging browser adapter for SDK browser/web actions.
4. Implement real MCP server and marketplace service handlers on top of SDK/core MCP capabilities.
5. Implement OAuth/account callback handling outside VS Code auth providers.
6. Complete SDK checkpoint/diff parity: editor and `apply_patch` writes now open Visual Studio diffs, but checkpoint-history diff/restore buttons still need deeper SDK metadata mapping.
