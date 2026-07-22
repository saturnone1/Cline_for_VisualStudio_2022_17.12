# AI maintenance guide

This repository favors explicit ownership and fast verification over architectural ceremony.

## Find the owner first

| Change | Primary source |
| --- | --- |
| Product version | `packaging/ProductVersion.props` |
| WebView RPC operation or payload | `contracts/webview-rpc.json` |
| Visual Studio Host RPC method | `contracts/host-rpc.json` |
| Chat/session behavior | `src/sidecar/src/features/chat` |
| Task history query and storage semantics | `src/sidecar/src/features/taskHistory` |
| Cline SDK translation | `src/sidecar/src/infrastructure/sdk` |
| WebView rendering and local interaction state | `src/webview/README.md`, then the owning component/context |
| Visual Studio/WebView2/sidecar process lifecycle | `src/extension/README.md`, then `ToolWindows` or `Host` |
| 17.0 versus 17.12 compatibility metadata | `packaging/vs2022-*` |

Do not edit generated RPC files, `ProductVersionAssemblyInfo.cs`, or `artifacts/WebApp` by hand.

## Composition boundaries

`SidecarConnectionFactory` builds one complete `RuntimeWebviewFeatures` object and configures it atomically. Never restore per-feature setter injection. `WebviewBackendComposition` is the runtime assembly point, not a feature implementation. Keep feature-specific wiring in focused modules such as:

- `ContextCompactionComposition`
- `TaskHistoryComposition`
- `WebviewRpcComposition`

New feature behavior belongs in a feature handler or flow. The composition root should only connect callbacks, ports, and handlers.

## State rules

- Sidecar state is authoritative for persisted settings, task history, conversation projection, and the active task lifecycle snapshot. SDK status and WebView state are observations of that snapshot, not competing sources of truth.
- WebView state is ephemeral unless a typed RPC explicitly persists it.
- `size` in task history means serialized UTF-8 storage bytes, never message count.
- History fuzzy search belongs to the WebView; sidecar applies workspace/favorite filters and stable non-relevance sorting.
- Scheduled conversation persistence uses deferred I/O; lifecycle boundaries use an immediate flush.

## Required verification

```powershell
.\scripts\Verify-Repository.ps1
```

Use `-SkipVsix` only for a fast local iteration. Run the default full verification before publishing or handing off a cross-runtime change.
Add `-RequireTrackedArtifacts` before a commit or release to verify that every generated WebApp file and its manifest are included in Git.

Before a release that changes package loading, ToolWindow startup, WebView2 initialization, or host lifecycle, run the opt-in real-host smoke against the matching VSIX:

```powershell
.\scripts\Test-VisualStudioExperimentalInstance.ps1 -VsixPath .\src\extension\bin\17.12\Release\VsClineAgent.vsix
```

This installs only into the named Visual Studio experimental root suffix, opens `View.LIGVS`, closes Visual Studio, and verifies that the sidecar process exits. It is intentionally not part of headless CI because it requires an interactive Visual Studio installation. The same check can be selected after a full build with `Verify-Repository.ps1 -RunExperimentalVs`.

When changing a WebView RPC shape, run `node scripts/generate-webview-rpc-contracts.mjs`. When changing a Visual Studio Host RPC method, run `node scripts/generate-host-rpc-contracts.mjs`. Review the manifest and every generated diff. When changing the product version, edit only `packaging/ProductVersion.props` and run `scripts/Sync-ProductVersion.ps1`.
