# VS2022 SDK Coverage

This is the canonical SDK coverage tracker for the Visual Studio 2022 Cline
port. The VSIX owns Visual Studio hosting, WebView2, LIG branding, and host
adapters; `@cline/sdk` remains the runtime source of truth.

Reviewed on 2026-06-06 against local `@cline/sdk` 0.0.43, upstream Cline
3.86.0, and the public Cline SDK docs for ClineCore, tools, scheduled agents,
subagents, checkpoints, and MCP behavior.

## Summary

All tracked stages are at least 80% covered. A stage only counts when SDK
capability, Visual Studio host adapter, WebView UX, persisted state, and
diagnostics agree. Reduced/no-op handlers prevent broken UI, but do not count as
full parity.

Air-gap remains the default: MCP marketplace install, browser launch, and web
fetch are opt-in or explicitly disabled unless configured.

| Stage | Track | Coverage | Done | Not Done | Next |
| --- | --- | ---: | --- | --- | --- |
| 1 | Terminal and command execution | 85% | Reusable VS command-host sessions, command ids, cancellation, hot/background state, cwd snapshots, unretrieved output, readable command cards, Attach, Continue, and Open Output actions. | Native VS terminal-pane parity and deeper shell environment introspection. | Add host-specific terminal pane affordances where VS APIs allow it. |
| 2 | MCP server lifecycle | 80% | Settings-file servers register/list/toggle/restart/delete/connect, expose SDK `extraTools`, and surface resource/template/prompt metadata through SDK method detection with fallbacks. | Remote MCP OAuth callback parity and online marketplace install. | Implement deployment-required remote auth only; keep marketplace out of air-gap. |
| 3 | Browser tools and web fetch | 80% | Browser settings, Chrome/Edge discovery, remote-debug probes, gated `fetch_web_content`, DevTools tab/action/screenshot execution, session/action ids, reconnect phases, timeout cleanup, and transcript rows. | Real Chrome/Edge smoke coverage by default and automatic browser relaunch parity. | Add env-gated real-browser smoke tests and launch/reconnect polish. |
| 4 | OAuth, account, and provider auth | 80% | Local/API-key snapshots, provider credential save/status/clear, SDK provider fields, OpenAI Codex/OCA/LIG OAuth callback, token exchange, expiry/refresh state, and refresh RPCs. | Deployment-specific account organization, credit, spend-limit, and global Cline account workflows. | Add only provider/account controls required by deployment. |
| 5 | Checkpoint, diff, review, undo/revert | 80% | Edit cards, review-on-demand, snapshot undo/revert, SDK checkpoint restore, and transcript-visible checkpoint compare comments tied to stored edit snapshots. | True SDK checkpoint diff streams are not exposed by the current SDK. | Replace limitation comments when upstream exposes diff streams. |
| 6 | Worktree | 80% | Porcelain worktree list, create/delete/merge/switch RPCs, `.worktreeinclude`, dirty/locked/prunable status, changed files, base selection, per-worktree task routing, folder fallback, and merge status/abort/continue. | More host validation for unusual folder-only and conflict states. | Add focused manual/host tests for edge cases. |
| 7 | Hooks, scheduled agents, plugins, subagents | 80% | Local hooks, transcript hook cards, `PreToolUse` block/input patch/validation/context/structured decision metadata, `.cline/cron` CRUD/manual run/history, local plugin status, and SDK team progress rendering. | Additional upstream hook lifecycle names, scheduler queue controls, and deployment-specific team routing policy. | Extend only required lifecycle/team behaviors. |
| 8 | Provider and model catalog | 80% | Ollama and OpenAI-compatible refresh, OpenAI/OCA/LIG-compatible API key or OAuth token auth, SDK/provider metadata first, endpoint metadata second, conservative inference last, diagnostics, and honest reduced states. | Provider-specific non-OpenAI catalog APIs not required by deployment. | Add provider APIs only when selected for deployment. |

## UI/UX Parity

Done:

- Welcome, Home, Account, About, and VSIX surfaces use LIG branding assets while
  retaining Cline's core task-first workflow.
- Chat task header, command cards, tool rows, browser phase rows, checkpoint
  controls, MCP rows, worktree view, hooks, scheduled-agent, plugin, and
  subagent status surfaces expose real or reduced state instead of transport
  failures.
- Visual Studio limitations are shown as supported, reduced, air-gap disabled,
  or unsupported instead of fake success.

Not done:

- Some upstream Cline affordances remain VS Code-specific: terminal shell
  integration, VS Code authentication providers, marketplace install flows,
  extension-host storage/secrets, and inline comment/diff UI.
- Some legacy C# fallback handlers still exist for startup hydration and older
  commands. They must not override sidecar-owned SDK behavior.

Next:

- Keep moving WebView service ownership from C# fallback to sidecar SDK handlers.
- Audit new upstream Cline UI changes before raising future coverage.
- Keep LIG branding as visual skin only; do not fork Cline task semantics.

## Implementation Evidence

- SDK baseline: `sidecar/package.json` and lockfile use `@cline/sdk` 0.0.43.
- Host bridge: terminal attach/continue/open-output, folder-open fallback, and
  Visual Studio command host state are wired through C# host RPCs.
- Sidecar: SDK runtime feature-detects optional MCP/checkpoint/provider APIs and
  fails closed with explicit diagnostics when missing.
- Browser: sidecar-owned DevTools registry tracks action phases, screenshots,
  reconnect state, and session cleanup.
- Auth/catalog: provider-scoped token state and catalog diagnostics are surfaced
  without faking global account login.
- Branding: selected `Signature_PNG` assets are optimized into WebView/VSIX
  assets instead of dumping the full source folder.

## Validation

Passed on 2026-06-06:

- `sidecar`: `npm install @cline/sdk@0.0.43`
- `sidecar`: `npm install`
- `sidecar`: `npm run check`
- `sidecar`: `npm run build`
- `webview-ui`: `npm install`
- `webview-ui`: `npm run build`
- `webview-ui`: `npm test` - 16 files, 150 tests
- Visual Studio MSBuild Clean/Rebuild produced
  `VsClineAgent/bin/Debug/VsClineAgent.vsix` version 1.1.26.

Observed warnings:

- WebView tests still emit existing React `act(...)` warnings in
  `ModelDescriptionMarkdown` tests.
- MSBuild still emits 10 existing VSTHRD analyzer warnings in
  `ChatToolWindowControl.xaml.cs` and `SidecarProcess.cs`.
- The duplicate WinFX import warning was removed.

## Remaining Backlog

1. Native VS terminal-pane improvements and richer shell environment tracking.
2. Remote MCP OAuth callback parity for deployment-required servers.
3. Opt-in real Chrome/Edge smoke tests and launch/reconnect polish.
4. Deployment-specific account organization, credit, and spend controls.
5. True SDK checkpoint diff stream mapping when upstream exposes it.
6. Harder worktree conflict/folder-only validation.
7. Additional hook lifecycle names, scheduler queue controls, and team routing
   policy if required.
8. Non-OpenAI provider catalog APIs only for selected deployment providers.

## Reference Files

- `PORT-FIDELITY-GAPS.md`: concise UI/SDK parity gap index.
- `UPSTREAM_BASELINE.md`: upstream baseline and packaging notes.
- `AIR-GAP-BUILD.md`: offline/runtime packaging instructions.
- `sidecar/README.md`: sidecar commands and runtime layout.
