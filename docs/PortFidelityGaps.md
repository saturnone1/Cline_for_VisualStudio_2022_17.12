# Port Fidelity Gaps

This file is the concise gap index for the Visual Studio 2022 Cline port. The
coverage percentages and implementation evidence live in
`Vs2022SdkCoverage.md`.

## Current Rule

Do not mark a feature as complete only because `@cline/sdk` exposes it. Visual
Studio parity requires:

- SDK runtime support.
- Visual Studio host adapter support.
- WebView controls and transcript state.
- Persisted settings/session behavior.
- Honest diagnostics for reduced, air-gap disabled, or unsupported paths.

## Done

- SDK baseline moved to `@cline/sdk` 0.0.43.
- Terminal command cards expose command ids, cwd/output state, Attach, Continue,
  Open Output, and normalized command text for string/JSON/array payloads.
- Activity/tool progress and terminal progress split into separate transcript
  rows so a completed file-read/search phase does not absorb later command
  output.
- MCP settings-file lifecycle routes through SDK helpers where available and
  keeps reduced/operation diagnostics visible after refresh.
- Browser/Web fetch paths are settings-controlled, diagnostic, transcript-visible, and backed
  by sidecar DevTools session/action/tab ids.
- OpenAI Codex/OCA/LIG provider auth state tracks token expiry and refresh.
- Checkpoint compare/restore is visible in the transcript, with SDK diff-stream
  limitations called out.
- Worktree create/switch/merge/delete and per-worktree task routing are wired.
- Hooks, `.cline/cron`, local plugin status, and SDK team progress have usable
  Visual Studio WebView surfaces.
- Provider catalogs prefer SDK/provider metadata, then endpoint metadata, then
  conservative reduced fallback.
- LIG branding uses selected optimized assets from `Signature_PNG` without
  replacing Cline's task-first UX.

## Not Done

- Native VS terminal shell integration is not equivalent to VS Code shell
  integration.
- Remote MCP OAuth and marketplace install are not full upstream parity.
- Browser launch/reconnect automation still needs real Chrome/Edge smoke
  coverage outside the default mocked path.
- Global Cline account organization, credit, and spend-limit flows remain
  deployment-specific.
- True SDK checkpoint diff streams are blocked until the SDK exposes them.
- Unusual worktree folder-only and merge-conflict states need more host tests.
- Additional hook lifecycle names and scheduler queue controls are not yet
  required by deployment.
- Non-OpenAI provider-specific catalog APIs are only reduced unless selected for
  deployment.

## UI/UX Differences To Keep Visible

- VS Code-only extension commands map to Visual Studio commands or reduced
  messages.
- VS Code authentication providers map to src/sidecar/host OAuth callback bridges
  only for required providers.
- VS Code webview URI helpers map to packaged WebView2 assets.
- VS Code terminal, diff, comments, storage, and secrets APIs map to
  Visual Studio-specific adapters.
- Air-gap policy disables online marketplace install; web fetch is controlled by browser settings.

## Next Implementation Order

1. Add focused host/manual tests for terminal attach/continue, worktree folder
   fallback, and merge recovery.
2. Add real-browser smoke tests behind an environment flag.
3. Add deployment-selected provider/account APIs only when required.
4. Re-audit upstream Cline UI after each SDK or upstream baseline update.
