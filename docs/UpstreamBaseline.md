# Upstream Cline Baseline

## 기준

- Upstream working copy: `../cline-upstream-temp`
- Baseline commit: `5efa8cfd3f1746ad7dbe72fcdba31eeb7ad858c4`
- Upstream Cline package version: `3.86.0`
- Target host: Visual Studio 2022 17.12 VSIX
- VSIX version: `1.1.37`
- SDK baseline: `@cline/sdk` 0.0.43
- Porting direction: C# VSIX host + WebView2 transport + Node 22 sidecar +
  Cline SDK runtime.

## 현재 포팅 상태

완료된 기반:

- VSIX가 WebView2 ToolWindow를 띄우고 Node sidecar와 named pipe JSON-RPC로
  연결한다.
- WebView 메시지는 sidecar-first로 처리되고, 미처리 메시지만 C# bridge로
  fallback된다.
- `VisualStudioHostProvider`는 upstream HostProvider의 workspace, window,
  env, diff 구조를 Visual Studio host RPC로 매핑한다.
- `VisualStudioWebviewRouter`는 SDK session event, WebView service RPC,
  persisted state, diagnostics, browser/MCP/auth/worktree/hook/catalog helpers를
  sidecar에서 소유한다.
- `Vs2022SdkCoverage.md` 기준 8개 Stage는 각각 90% 이상이며, 남은 gap은
  Visual Studio 전용 API 차이와 air-gap 정책으로 분리해 추적한다.
- VSIX는 Node 22.15.0, `cline-sidecar.js`, host bridge, WebView router, bundled
  WebApp, selected LIG assets, and sidecar runtime package artifacts를 포함한다.

현재 sidecar -> VS host API:

- Workspace: roots, workspace paths, diagnostics, open documents, file exists,
  read/write/create/list/search/delete, save dirty document, execute command,
  terminal state, unretrieved terminal output, open problems, open terminal
  output, attach terminal command, continue terminal command, and open folder.
- Window: active file, open file, show message.
- Env: platform, host version, clipboard read/write, open external, debug log.
- Diff: open diff, close all diffs.

## Upstream UI/UX Parity

완료:

- Welcome/Home/Account/About surfaces keep the Cline task-first flow while using
  LIG VS branding.
- Chat rows render normalized SDK messages, command cards, browser phases, tool
  activities, checkpoint controls, and subagent/team progress.
- Settings expose provider auth/catalog, terminal, browser, feature, MCP, rules,
  hooks, scheduled-agent, plugin, and worktree controls with honest reduced
  states where Visual Studio differs from VS Code.

미완료:

- VS Code shell integration, authentication provider API, webview URI helpers,
  marketplace install, inline comments, extension-host storage, and VS Code
  command contribution points require Visual Studio-specific replacements.
- Some legacy C# fallback handlers remain as startup/compatibility safety nets
  and must not become the source of truth again.

## SDK Tool Parity

- File read/write/list/search/edit/apply-patch operations route through SDK and
  Visual Studio host adapters.
- Command execution uses reusable Visual Studio command-host sessions and
  command cards, but native terminal-pane parity is still future work.
- MCP server lifecycle and resource/prompt metadata use SDK APIs when exposed,
  with explicit fallback diagnostics.
- Browser/web fetch paths are controlled by browser settings and executed through
  sidecar DevTools helpers when enabled.
- Checkpoint restore/compare is visible through SDK/session metadata and stored
  edit snapshots; true SDK diff streams are pending upstream support.
- Hooks, scheduled agents, plugins, subagents, provider catalogs, and OAuth
  provider state have Visual Studio WebView/sidecar surfaces for the deployment
  providers currently in scope.

## 주요 제약

- Runtime source of truth is `Sidecar/node_modules/@cline/sdk` and
  `src/sidecar/src/infrastructure/sdk/ClineSdkRuntime.ts`; the old standalone ProtoBus core path is
  historical.
- Node 22+ remains required by the SDK and bundled native modules.
- Air-gap remains available for deployment. Online MCP marketplace install is
  disabled, while web fetch/browser use is controlled by user settings.
- `*.vsix`, `bin/`, `obj/`, `artifacts/Sidecar/`, and generated WebApp/VSIX
  outputs are build artifacts, not commit targets unless explicitly requested.

## 검증 명령

```powershell
cd Cline_for_VisualStudio_2022_17.12\sidecar
npm install
npm run check
npm test
npm run build
```

```powershell
cd Cline_for_VisualStudio_2022_17.12\src/webview
npm run build
npm test
```

```powershell
& "C:\Program Files\Microsoft Visual Studio\18\Community\MSBuild\Current\Bin\MSBuild.exe" `
  VsClineAgent.sln /t:Clean`;Rebuild `
  /p:Configuration=Debug `
  /p:DeployExtension=false `
  /p:DesignTimeBuild=false
```

```powershell
tar -tf src\extension\bin\Debug\VsClineAgent.vsix |
  Select-String -Pattern "extension.vsixmanifest|Assets/lig-wordmark-white|WebApp/assets/lig-|Sidecar/cline-sidecar"
```
