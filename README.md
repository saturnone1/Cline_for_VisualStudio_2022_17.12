# LIG VS — Cline for Visual Studio 2022 (17.0 and 17.12)

A VSIX project that ports Cline to Visual Studio 2022.

The approach here is deliberately **not** to reimplement the Cline agent runtime in C#.
`@cline/sdk` runs in a Node sidecar; the Visual Studio extension supplies the WebView2 UI,
process lifecycle, named-pipe JSON-RPC, and the Visual Studio host adapters.

## Overview

| | |
|---|---|
| Extension name | `VS AI Agent (Cline Port)` |
| Target IDE | Visual Studio 2022, 17.0 line and 17.12+, amd64 |
| VSIX project | `src/extension/VsClineAgent.csproj` |
| Target framework | .NET Framework 4.8 (17.0 profile), 4.7.2 (17.12 profile) |
| Runtime shape | VSIX + WebView2 + Node sidecar + `@cline/sdk` |

What it gives you inside Visual Studio: Cline-style chat, file read/edit, search, command
execution, task history, and parts of MCP and checkpoints.

For air-gapped use, the WebView2 Fixed Version Runtime, the Node runtime, SDK
dependencies and NuGet packages are bundled into the VSIX or into local packages.

## Repository layout

```text
.
├─ src/extension/           # Visual Studio VSIX host and VS host adapters
├─ src/sidecar/             # Node sidecar and @cline/sdk integration
├─ src/shared/              # TypeScript shared by the WebView and the sidecar
├─ src/webview/             # React/Vite WebView UI
├─ packaging/               # per-version SDK, manifest, compatibility profiles
├─ assets/                  # images and static assets used from source
├─ artifacts/               # build output; only WebApp is tracked
├─ docs/                    # architecture, compatibility, air-gap notes
├─ scripts/                 # build and deployment helpers
└─ vendor/                  # local NuGet feed and optional WebView2 runtime
```

`artifacts/WebApp/` is generated output, tracked as a deliberate exception because it is
the reviewed offline-packaging input for both VSIX variants. Do not hand-edit it — see
[Generated artifact policy](docs/GeneratedArtifacts.md).

## Prerequisites

- Visual Studio 2022 17.x with the **Visual Studio extension development** workload
- .NET Framework 4.7.2 and 4.8 Developer Packs
- Node.js 22+ (for development and building)
- WebView2 Runtime, or the WebView2 Fixed Version Runtime
- Air-gapped builds additionally need `vendor/LocalPackages/`, the WebView2 Fixed Runtime,
  and the sidecar's `node_modules.zip` staged in advance

To populate the local NuGet cache from a machine with internet access:

```powershell
.\scripts\Download-Packages.ps1
```

To bundle the WebView2 Fixed Version Runtime into the VSIX, use either form:

```powershell
.\scripts\Bundle-WebView2Runtime.ps1 -SourceCab "D:\offline\Microsoft.WebView2.FixedVersionRuntime.<version>.x64.cab"
.\scripts\Bundle-WebView2Runtime.ps1 -SourceRuntime "D:\offline\Microsoft.WebView2.FixedVersionRuntime.<version>.x64"
```

## Building

Sidecar:

```powershell
cd src/sidecar
npm install
npm run build
```

WebView UI:

```powershell
cd src/webview
npm install
npm run build
```

VSIX:

```powershell
.\scripts\Build-VsixVariants.ps1 -Configuration Release
```

This produces **both** the `17.0` and `17.12` VSIX from one common sidecar, WebView and
C# host source tree. Everything version-specific — SDK, target framework, identity,
install scope — lives only in the `packaging/vs2022-17.0/` and `packaging/vs2022-17.12/`
profiles.

Output normally lands at:

```text
src/extension/bin/17.0/Release/VsClineAgent17.vsix
src/extension/bin/17.12/Release/VsClineAgent.vsix
```

## Running

1. Install `VsClineAgent.vsix`.
2. Restart Visual Studio 2022.
3. Open `View > AI Agent`.
4. Pick an LLM provider and model in settings.

**End users do not need to install Node.js.** The VSIX packages and runs its own Node
runtime and SDK dependencies for the sidecar; Node.js 22+ is only needed to rebuild or
develop the sidecar.

Local Ollama example:

```text
Base URL: http://localhost:11434/v1
Model: qwen3-coder:latest
```

## Implementation status

### Working

- VSIX package and Tool Window registration
- Cline UI hosted in WebView2
- Node sidecar process start and shutdown management
- named-pipe JSON-RPC between the C# host and the sidecar
- ClineCore local backend on `@cline/sdk`
- SDK session start, send, cancel, query, modify, delete
- SDK message/history reads and WebView state hydration
- SDK events normalised into WebView messages and partial messages
- tool approval requests routed to the WebView approval UI
- follow-up question UI with user-response waiting
- file read, write, search and listing relative to the Visual Studio workspace
- `.clineignore`-aware automatic file search and listing
- change tracking and change cards for `apply_patch` / editor-family edits
- opening Visual Studio diffs
- command execution host adapter
- reusable `cmd.exe` command session, command id, terminal id, UTF-8 codepage
- command cancellation, long-running command detection, recent/uncollected output queries
- partial rules, workflows and skills listing/toggling from SDK settings
- SDK checkpoint restore and transcript-visible checkpoint compare metadata
- MCP settings-file server registration, listing, connection, tool discovery, toggle,
  timeout, restart and delete (partial)
- safe C# initial state for the WebView's first render
- interaction diagnostics under `%LOCALAPPDATA%\VsClineAgent\logs`
- WebView2 Fixed Runtime bundling path for air-gapped deployment
- sidecar Node dependencies packaged as `node_modules.zip`, expanded locally on first run

### Partial

- **Command execution** — commands run and output cards work, but this is not fully
  integrated with the Visual Studio terminal pane.
- **Checkpoints** — the SDK restore path exists; diff/review/undo parity is limited.
- **MCP** — settings-file servers and SDK tool wiring are partly supported; marketplace
  install, OAuth callback, and resource/prompt listing are not complete.
- **Browser / web fetch** — `fetch_web_content` is on by default and can only be turned
  off via the browser-tool setting. Settings show whether web fetch is available, why it
  is disabled, and Chrome DevTools connection version/tab diagnostics. SDK 0.0.43 ships
  only `webFetch` as a built-in, so the Chrome-debugging browser action adapter is a
  separate implementation.
- **Provider / model catalog** — Ollama, LM Studio, LiteLLM, OpenAI-compatible,
  OpenRouter, Requesty, Groq, Vercel AI Gateway and internal OpenAI-compatible endpoints
  can list models and show basic capability/pricing metadata; provider-specific catalog
  APIs and OAuth-based provider setup are reduced.
- **Account / auth** — unauthenticated state snapshots, safe provider-auth button
  responses, SDK provider auth requirements metadata, local/env-var credential
  store/status/delete RPCs, settings-driven authorization URL launch, a localhost OAuth
  callback bridge, settings-driven authorization-code token exchange, and credential
  hand-off to SDK sessions all work. Per-provider refresh and signed-in propagation still
  need Visual Studio-specific work.
- **Rules / workflows / skills** — settings query and toggle partly work; the `skills`
  execution tool stays disabled until the approval/execution UX is finished.
- **Worktree service** — the sidecar git adapter handles list/create/switch/merge/delete,
  with dirty/locked/prunable state, changed-file summaries, local branch checkout,
  local/remote base branch selection, multi-solution selection, and switching between the
  current and a new Visual Studio window. Worktrees-view polling pauses during operations
  so selection and status messages are not overwritten. Per-worktree task routing and deep
  conflict recovery remain.
- **Hooks / subagents / scheduled agents** — local hook files in `.clinerules/hooks` and
  `~/.cline/hooks` can be created, toggled and deleted from the WebView, and run across
  the task/resume/tool lifecycle. A `PreToolUse` hook's JSON response can block tool
  execution and patch tool input. The Subagents toggle forwards to SDK spawn/team agent
  settings, and Scheduled Agents enables SDK workspace automation from a local
  `.cline/cron` spec. Richer upstream hook response semantics, scheduled-agent management
  UX and subagent execution UX remain.

### Not implemented / main remaining work

- first-class Visual Studio terminal pane integration
- explicit continue/attach actions for long-running commands, wired to the terminal pane
- upstream-level parity for file change Review, Undo, Revert and multi-file review
- true checkpoint diff streams and richer checkpoint review metadata
- Chrome-debugging browser actions, screenshots and tab lifecycle streaming
- MCP marketplace catalog and install
- MCP OAuth authenticate callback
- MCP resource, resource-template and prompt listing
- Visual Studio-compatible OAuth refresh and account login/logout
- auth flow parity for OAuth-backed providers such as OpenAI Codex
- provider/model catalog streaming and precise per-provider capability metadata
- worktree merge conflict abort/continue/recovery UX
- folder-only (solution-less) worktree switching, and per-worktree task/session routing
- advanced hook semantics and validation messages from hook JSON responses
- scheduled-agent spec/run management UX
- plugin install and configuration surface
- subagent/team execution status and approval UX

## Runtime boundary

**The C# VSIX owns:**

- extension package initialisation
- the Tool Window and WebView2 hosting
- Node sidecar lifecycle
- named-pipe JSON-RPC transport
- Visual Studio host adapters — workspace, editor, command execution, diff, clipboard,
  storage, secrets
- preparing the WebView2 and sidecar runtimes

**The Node sidecar and `@cline/sdk` own:**

- ClineCore session lifecycle
- the agent loop and tool semantics
- streaming and event normalisation
- the SDK tool approval flow
- SDK settings, history, checkpoints and the MCP manager
- WebView service and RPC routing

When adding a feature, **do not rebuild the agent runtime in C#.** Add it at the sidecar
and SDK/host-adapter boundary wherever possible.

## Further reading

| Document | Contents |
|---|---|
| `docs/Vs2022SdkCoverage.md` | Current status, parity gaps, work priorities |
| `docs/PortFidelityGaps.md` | Pointer from the older gap document to the current one |
| `docs/UpstreamBaseline.md` | Upstream baseline information |
| `docs/AirGapBuild.md` | Air-gapped build and installation notes |
| `src/sidecar/README.md` | Sidecar development notes |
