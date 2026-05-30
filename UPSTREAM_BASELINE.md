# Upstream Cline Baseline

## 기준

- Upstream working copy: `../cline-upstream-temp`
- Baseline commit: `5efa8cfd3f1746ad7dbe72fcdba31eeb7ad858c4`
- Target host: Visual Studio 2022 17.12 VSIX
- Porting direction: C# VSIX host + WebView2 transport + Node sidecar running upstream TypeScript runtime as much as possible.
- Upstream Cline package version: `3.86.0`

## 현재 포팅 상태

### 완료된 기반

- VSIX가 WebView2 ToolWindow를 띄운다.
- VSIX가 Node sidecar를 시작하고 named pipe JSON-RPC로 연결한다.
- WebView 메시지는 sidecar-first로 relay되고, 미처리 메시지만 기존 C# bridge로 fallback된다.
- sidecar TypeScript 빌드가 `VsClineAgent/Sidecar` 런타임 파일로 복사된다.
- VSIX 패키지에 다음 런타임 파일이 포함된다.
  - `Sidecar/cline-sidecar.js`
  - `Sidecar/host/VisualStudioHostBridgeClient.js`
  - `Sidecar/host/VisualStudioHostProvider.js`
  - `Sidecar/ipc/types.js`
  - `Sidecar/webview/VisualStudioWebviewRouter.js`
- `VisualStudioHostProvider`가 upstream `HostProvider`의 `workspace/window/env/diff` 분리 구조를 따라가기 시작했다.
- `VisualStudioWebviewRouter`가 sidecar-owned WebView service handler를 분리해, C# bridge fallback을 점진적으로 줄일 수 있는 구조가 생겼다.
- Upstream standalone `cline-core.js`가 VSIX에 패키징된다.
- VSIX가 `Sidecar/node.exe` Node 22.15.0 런타임을 포함한다.
- sidecar가 upstream standalone core용 gRPC HostBridge를 열고, HostBridge 요청을 Visual Studio named-pipe host API로 forward한다.
- smoke test에서 upstream core가 `ProtoBus gRPC server listening`, `Registered instance`, `All services started successfully`까지 도달했다.

### 현재 sidecar -> VS host API

- Workspace
  - `workspace.getRoots`
  - `workspace.getWorkspacePaths`
  - `workspace.getDiagnostics`
  - `workspace.getOpenDocuments`
  - `workspace.fileExists`
  - `workspace.readTextFile`
  - `workspace.writeTextFile`
  - `workspace.createDirectory`
  - `workspace.listFiles`
  - `workspace.searchFiles`
  - `workspace.executeCommandInTerminal`
  - `workspace.saveOpenDocumentIfDirty`
  - `workspace.openProblemsPanel`
  - `workspace.openTerminalPanel`
- Window
  - `window.getActiveFile`
  - `window.openFile`
  - `window.showMessage`
- Env
  - `env.getPlatform`
  - `env.getHostVersion`
  - `env.clipboardReadText`
  - `env.clipboardWriteText`
  - `env.openExternal`
  - `env.debugLog`
- Diff
  - `diff.openDiff`
  - `diff.closeAllDiffs`

## Upstream tool handler parity

Upstream handler 목록 기준:

- `ReadFileToolHandler.ts`: host API 기반 준비됨.
- `WriteToFileToolHandler.ts`: host API 기반 준비됨.
- `ListFilesToolHandler.ts`: host API 기반 준비됨.
- `SearchFilesToolHandler.ts`: host API 기반 준비됨. 현재 구현은 단순 파일명/본문 포함 검색이며 ripgrep 수준 parity는 아님.
- `ExecuteCommandToolHandler.ts`: host API 기반 준비됨. 현재 구현은 VS Output Window에 출력하는 process 실행이며 upstream terminal semantics와는 차이가 있음.
- `ApplyPatchHandler.ts`: host API 일부 준비됨. upstream patch parser/runtime 연결은 아직 안 됨.
- `BrowserToolHandler.ts`: 미구현.
- `WebFetchToolHandler.ts`: 미구현.
- `WebSearchToolHandler.ts`: 미구현.
- `UseMcpToolHandler.ts`, `AccessMcpResourceHandler.ts`: 미구현.
- `UseSkillToolHandler.ts`, `SubagentToolHandler.ts`: 미구현.
- `AttemptCompletionHandler.ts`, `AskFollowupQuestionToolHandler.ts`, `PlanModeRespondHandler.ts`, `ActModeRespondHandler.ts`: upstream runtime/controller 연결 후 처리해야 함.

## 주요 blocker

- [2026-05-30 SDK 전환] standalone `upstream-core/cline-core.js`/ProtoBus relay 방식은 폐기했다. 현재 기준 runtime source of truth는 `Sidecar/node_modules/@cline/sdk`와 `sidecar/src/sdk/ClineSdkRuntime.ts`다.
- [2026-05-30 SDK 전환] `@cline/sdk@0.0.42`는 Node `>=22`가 필요하므로 VSIX에 `Sidecar/node.exe` 22.15.0을 계속 번들한다.
- Upstream generated host bridge types가 현재 working copy에 생성되어 있지 않다. `apps/vscode/src/hosts/host-provider-types.ts`는 `@generated/hosts/host-bridge-client-types`를 참조한다.
- Upstream package dependency/proto generation이 이 포팅 프로젝트 안에 아직 정식으로 편입되지 않았다.
- `StateService.subscribeToState`와 task lifecycle은 아직 C# fallback이 소유한다.
- `StateService.subscribeToState`는 아직 C# fallback이 소유한다. sidecar로 섣불리 옮기면 C# `AgentController`가 만드는 task 상태 갱신이 UI에 도달하지 않는다.
- WebView gRPC 메시지는 이제 standalone ProtoBus로 relay하지 않는다. 다음 단계는 WebView task/state 요청을 `sdk.*` JSON-RPC와 Cline SDK session event 구독으로 연결하는 것이다.
- C# `AgentController`, C# tool registry, C# bridge placeholder가 아직 runtime fallback으로 남아 있다.
- Windows x64 native module 기준으로 `better-sqlite3` prebuild가 포함되어 있다. 다른 CPU/OS 타겟을 지원하려면 upstream standalone universal packaging 흐름이 필요하다.

## 검증 명령

```powershell
cd Cline_for_VisualStudio_2022_17.12\sidecar
npm run check
npm run build
```

```powershell
& "C:\Program Files\Microsoft Visual Studio\18\Community\MSBuild\Current\Bin\amd64\MSBuild.exe" Cline_for_VisualStudio_2022_17.12\VsClineAgent.sln /p:Configuration=Debug /p:RestorePackagesPath=Cline_for_VisualStudio_2022_17.12\LocalPackages /p:DeployExtension=false /restore /v:minimal
```

```powershell
tar -tf Cline_for_VisualStudio_2022_17.12\VsClineAgent\bin\Debug\VsClineAgent.vsix | Select-String -Pattern "Sidecar/(cline-sidecar|host|ipc)"
```

```powershell
tar -tf Cline_for_VisualStudio_2022_17.12\VsClineAgent\bin\Debug\VsClineAgent.vsix | Select-String -Pattern "Sidecar/(node.exe|node_modules/@cline/sdk|sdk/ClineSdkRuntime.js)"
```
