# Cline 원본 보존형 Visual Studio VSIX 포팅 설계

## 목표

이 프로젝트의 목표는 Cline을 C#으로 재구현하는 것이 아니라, upstream Cline의 TypeScript 코어와 src/webview를 최대한 그대로 사용하면서 Visual Studio 2022 17.12에서 VSIX로 실행하는 것이다.

현재 구현은 Cline의 일부 개념을 C#으로 다시 만든 MVP에 가깝다. 원본과 동등한 동작을 목표로 한다면 방향을 바꿔야 한다.

## 핵심 결론

가장 현실적인 구조는 다음과 같다.

```text
Visual Studio VSIX (.NET Framework 4.7.2)
  ├─ ToolWindow + WebView2 host
  ├─ Visual Studio API adapter
  ├─ IPC bridge
  └─ Node sidecar process
       ├─ upstream Cline TypeScript core bundle
       ├─ upstream webview/service protocol
       ├─ VisualStudioHostProvider
       └─ Cline task/runtime/tools/checkpoints/MCP/providers
```

C#이 에이전트 런타임을 다시 구현하지 않는다. C#은 Visual Studio가 가진 IDE 기능을 Node 쪽 Cline core에 제공하는 host adapter가 된다.

## 왜 이 구조인가

Upstream Cline의 핵심은 `apps/vscode/src/core`와 `apps/vscode/src/hosts` 아래의 TypeScript 런타임이다. 여기에는 Task, Controller, ToolExecutor, CheckpointManager, TerminalManager, MCP, BrowserSession, ContextManager, provider/model discovery, hooks, skills, slash commands, webview grpc 서비스가 함께 엮여 있다.

이걸 C#으로 한 파일씩 옮기면 다음 문제가 생긴다.

- upstream 변경을 따라가기 어렵다.
- 도구/상태/스트리밍/승인 흐름이 계속 누락된다.
- webview는 원본인데 backend가 다른 의미를 가지게 된다.
- MCP, provider auth, checkpoint, browser, terminal 같은 복합 기능에서 의미 차이가 커진다.

반대로 Node sidecar에 upstream core를 그대로 싣고 Visual Studio용 host만 새로 만들면, 포팅 범위가 "Cline 전체 재작성"에서 "VS host implementation"으로 줄어든다.

## 최종 아키텍처

### 1. VSIX C# Host

역할:

- VSIX package 초기화
- ToolWindow 등록
- WebView2 로딩
- Node sidecar 시작/종료
- Visual Studio API 접근
- Node와 IPC 송수신
- VSIX 패키징/설치

남겨야 하는 파일군:

- `VsClineAgentPackage.cs`
- `ToolWindows/*`
- `Commands/*`
- Visual Studio adapter services
- sidecar launcher
- IPC bridge

줄여야 하는 파일군:

- `Agent/AgentController.cs`
- `Agent/Tools/*`
- `Agent/Prompts/*`
- C# LLM client
- C# assistant parser/diff applier

이 파일들은 장기적으로 runtime source of truth가 되면 안 된다. 원본 Cline core가 그 역할을 맡아야 한다.

### 2. Node Sidecar

역할:

- upstream Cline core 실행
- upstream webview grpc/service contract 처리
- Task lifecycle 관리
- tool execution orchestration
- model/provider/MCP/browser/checkpoint/context/hook/skill 처리
- Visual Studio host 기능이 필요한 순간 C# host에 IPC 요청

권장 엔트리:

```text
apps/visualstudio/src/sidecar.ts
```

또는 upstream repo를 직접 크게 바꾸기 전에는 이 프로젝트 아래에:

```text
src/sidecar/src/main.ts
```

를 두고 upstream `apps/vscode/src`를 workspace dependency처럼 참조한다.

### 3. VisualStudioHostProvider

Upstream Cline에는 이미 host abstraction 방향이 있다. VS Code 전용 구현을 그대로 복사하는 것이 아니라, 같은 계약을 Visual Studio용으로 구현한다.

구현 대상:

- workspace: 솔루션 루트, multi-root 대응, 파일 watcher
- editor: 현재 문서, 선택 영역, 열기/저장, diagnostics
- terminal: VS terminal 또는 pseudo terminal manager
- diff: VS diff view 또는 임시 파일 diff
- window: 메시지, progress, quick pick, input box
- clipboard
- file system
- storage: global/workspace storage
- secrets: VS 설정/Windows DPAPI 기반 저장
- uri/open external
- comments/review: 가능하면 VS comment/diff UI로 매핑, 아니면 webview 내 대체 UI

### 4. WebView Transport

원본 src/webview는 가능한 그대로 빌드한다.

권장 흐름:

```text
src/webview
  → window.chrome.webview.postMessage(...)
  → C# WebView2 host
  → IPC
  → Node sidecar Cline service handler
  → IPC
  → C# WebView2 host
  → webview postMessage(...)
```

즉, C# bridge가 service method를 직접 구현하지 않는다. 지금처럼 `VisualStudioClineBridge.cs`에 RPC별 placeholder를 늘리는 방식은 중단한다. C# bridge는 transport relay가 되어야 한다.

### 5. IPC

권장: JSON-RPC over named pipe.

이유:

- Windows/VSIX 환경에 잘 맞는다.
- 포트 충돌이 없다.
- 로컬 방화벽 이슈가 적다.
- streaming event를 message envelope로 표현하기 쉽다.

메시지 형태:

```json
{
  "id": "req-123",
  "method": "host.workspace.readFile",
  "params": {
    "path": "C:\\repo\\src\\Program.cs"
  }
}
```

응답:

```json
{
  "id": "req-123",
  "result": {
    "content": "..."
  }
}
```

이벤트:

```json
{
  "event": "webview.postMessage",
  "payload": {}
}
```

## 패키징 전략

### 기본

- upstream Cline TypeScript core를 esbuild로 production bundle 생성
- upstream src/webview를 Vite로 build
- VSIX에 다음을 포함
  - `WebApp/*`
  - `Sidecar/cline-sidecar.js`
  - `Sidecar/package.json` 또는 bundled dependency
  - Node runtime

### Node runtime

진짜 "설치하면 바로 동작"을 목표로 하면 Node를 같이 실어야 한다.

선택지:

1. Node embeddable zip 포함
   - 장점: 사용자 PC Node 설치 불필요
   - 단점: VSIX 크기 증가

2. 시스템 Node 사용
   - 장점: 패키지 작음
   - 단점: 설치 환경 의존, air-gap/enterprise 환경에서 실패 가능

목표가 Visual Studio용 완성 VSIX라면 1번이 맞다. 개발 중에는 2번으로 시작해도 된다.

## 마이그레이션 단계

### Phase 0: 기준선 고정

- upstream Cline commit hash 고정
- 현재 VS port와 upstream 간 기능 matrix 작성
- "C# 재구현 runtime"을 deprecated path로 표시
- Debug/Release VSIX 빌드 절차를 재현 가능하게 정리

완료 조건:

- `UpstreamBaseline.md`에 commit, build command, 차이 목록 기록
- 현재 생성 가능한 VSIX와 known limitations 기록

### Phase 1: sidecar 부팅

- `sidecar` 프로젝트 추가
- Node sidecar를 VSIX에서 실행
- C#에서 named pipe 연결
- ping/healthcheck 구현
- sidecar log를 VS Output Window에 연결

완료 조건:

- Visual Studio에서 ToolWindow 열면 sidecar가 뜬다.
- `health.ping` roundtrip이 된다.
- VS 종료/확장 unload 시 sidecar가 정리된다.

### Phase 2: webview relay 전환

- upstream src/webview build를 그대로 사용
- C# bridge의 RPC 직접 처리 제거
- webview 메시지를 sidecar로 relay
- sidecar에서 webview service contract 처리

완료 조건:

- Settings/Chat/History 기본 화면이 sidecar state에서 렌더링된다.
- placeholder `{}` 응답 없이 Node 쪽 handler가 응답한다.

### Phase 3: VisualStudioHostProvider 최소 구현

우선 구현:

- workspace root
- read/write file
- open file
- get active editor selection
- clipboard
- show message
- global/workspace storage
- secrets

완료 조건:

- `read_file`, `write_to_file`, `replace_in_file`, `list_files`, `search_files`가 upstream handler 그대로 돈다.
- C# `Agent/Tools/*`를 쓰지 않는다.

### Phase 4: terminal/diff/checkpoint

우선순위:

1. terminal manager
2. diff view provider
3. checkpoint manager
4. task resume/history

완료 조건:

- upstream `execute_command`가 Visual Studio host terminal abstraction을 통해 실행된다.
- approval/diff UI가 upstream webview와 의미상 일치한다.
- checkpoint restore가 upstream semantics에 가깝게 동작한다.

### Phase 5: MCP/browser/provider

우선순위:

1. MCP hub
2. browser_action
3. web_fetch / web_search
4. provider/model discovery
5. auth callback handling

완료 조건:

- MCP 서버 목록/도구 실행이 실제 동작한다.
- browser_action이 Chrome debugging session을 실제로 제어한다.
- provider 목록/모델 목록이 원본과 같은 흐름으로 갱신된다.

### Phase 6: parity hardening

- upstream e2e 중 host 비의존 테스트 이식
- tool handler parity tests
- webview service contract coverage
- task resume/checkpoint regression tests
- VSIX 설치 테스트
- air-gap packaging 테스트

완료 조건:

- 주요 Cline 기능을 Visual Studio에서 같은 시나리오로 검증한다.
- upstream 업데이트 시 깨지는 지점이 테스트로 드러난다.

## 현재 C# 구현의 처리 방침

현재 구현은 버리지 말고 다음 용도로 남긴다.

- bootstrap fallback
- VS API 호출 예제
- sidecar host adapter 구현 참고
- air-gap local LLM 설정 참고

하지만 다음 구성요소는 최종 runtime에서 제거하거나 비활성화해야 한다.

- C# AgentController
- C# tool registry
- C# assistant XML parser
- C# system prompt
- C# LLM client
- bridge-side fake MCP/provider/account/checkpoint handlers

이들이 남아 있으면 "Cline 원본을 그대로 포팅"이 아니라 "Cline 유사품 유지보수"가 된다.

## 권장 디렉터리 구조

```text
Cline_for_VisualStudio_2022_17.12/
  VsClineAgent/
    VsClineAgent.csproj
    VsClineAgentPackage.cs
    ToolWindows/
    Commands/
    Host/
      VisualStudioHostServer.cs
      SidecarProcess.cs
      NamedPipeJsonRpc.cs
      WorkspaceHostService.cs
      EditorHostService.cs
      TerminalHostService.cs
      StorageHostService.cs
    WebApp/
      index.html
      assets/
    Sidecar/
      cline-sidecar.js
      node.exe
      node_modules/
        @cline/sdk/
  src/sidecar/
    package.json
    tsconfig.json
    src/
      main.ts
      ipc/
      host/
        VisualStudioHostProvider.ts
        VisualStudioWorkspace.ts
        VisualStudioTerminal.ts
        VisualStudioDiffViewProvider.ts
      sdk/
        ClineSdkRuntime.ts
      webview/
        VisualStudioWebviewProvider.ts
```

## 가장 먼저 할 작업

1. upstream Cline을 git submodule 또는 고정 복사본으로 정리한다.
2. `sidecar` TypeScript 프로젝트를 만든다.
3. VSIX에서 sidecar 프로세스 실행과 named pipe ping을 붙인다.
4. webview 메시지를 Node로 relay한다.
5. upstream core에서 VS Code API 직접 의존이 터지는 지점을 찾아 `VisualStudioHostProvider`로 우회한다.

이 순서가 중요하다. 지금 빠진 도구를 C#으로 하나씩 추가하면 당장은 기능이 늘어나는 것처럼 보이지만, 원본 Cline parity와는 계속 멀어진다.

## 진행 상태

- [2026-05-30] Phase 1 시작: VSIX가 `Sidecar/cline-sidecar.js` Node 프로세스를 시작하고 named pipe JSON-RPC로 `health.ping`을 호출하는 최소 sidecar bootstrap을 추가했다.
- [2026-05-30] Phase 2 시작: WebView2 메시지를 먼저 sidecar의 `webview.message`로 보내고, sidecar가 `handled: false`를 반환하면 기존 C# `VisualStudioClineBridge`로 fallback하는 relay-first 경로를 추가했다. 아직 upstream Cline core는 sidecar에 연결되지 않았다.
- [2026-05-30] Phase 2 진행: sidecar가 `UiService.initializeWebview`, `UiService.onDidShowAnnouncement`, 그리고 기존 C# bridge에서도 dataless/inert였던 UI/MCP/model subscription 일부를 직접 처리하기 시작했다. `StateService.subscribeToState`는 상태 갱신 스트림까지 sidecar로 이관되기 전까지 C# bridge 소유로 남긴다.
- [2026-05-30] Phase 3 기반 시작: named pipe JSON-RPC를 양방향으로 확장했다. sidecar bootstrap 중 `host.roundtripTest`가 sidecar -> C# host의 `host.health` 요청을 수행하므로, 이후 `VisualStudioHostProvider`가 파일/워크스페이스/에디터 기능을 C# host에 요청할 수 있는 통로가 생겼다.
- [2026-05-30] Phase 3 진행: 패키징되는 `artifacts/Sidecar/cline-sidecar.js`를 `src/sidecar/src/main.ts` TypeScript 소스에서 빌드하도록 전환했다. 또한 sidecar -> C# host API에 `workspace.getRoots`, `workspace.readTextFile`, `workspace.fileExists`, `workspace.getOpenDocuments`, `window.getActiveFile`, `window.showMessage`, `env.getPlatform` alias를 추가했다.
- [2026-05-30] Phase 3 진행: sidecar에 `VisualStudioHostBridgeClient` TypeScript wrapper를 추가했다. 빌드 스크립트는 `src/sidecar/dist`의 entry와 보조 모듈을 `artifacts/Sidecar`로 복사하며, VSIX 내부에 `Sidecar/cline-sidecar.js`, `Sidecar/infrastructure/host/VisualStudioHostBridgeClient.js`, `Sidecar/infrastructure/transport/JsonRpcConnection.js`가 포함되는 것을 확인했다.
- [2026-05-30] Phase 3 진행: upstream VS Code hostbridge의 기본 표면을 따라 `workspace.getWorkspacePaths`, `workspace.getDiagnostics`, `window.openFile`, `env.getHostVersion`, `env.clipboardReadText`, `env.clipboardWriteText`, `env.openExternal`을 추가했다. Clipboard 호출은 Visual Studio/WPF UI dispatcher를 통해 실행하도록 보강했다.
- [2026-05-30] Phase 3 진행: sidecar에 upstream `HostProvider` 패턴을 닮은 `VisualStudioHostProvider`를 추가하고 `workspaceClient`, `windowClient`, `envClient`, `diffClient` 표면을 분리했다. VS host API에는 `workspace.executeCommandInTerminal`, `workspace.saveOpenDocumentIfDirty`, `workspace.openProblemsPanel`, `workspace.openTerminalPanel`, `diff.openDiff`, `env.debugLog`를 추가했다.
- [2026-05-30] Phase 3 진행: upstream tool handler가 우선 필요로 하는 파일 시스템 표면을 넓혔다. src/sidecar/C# host 양쪽에 `workspace.writeTextFile`, `workspace.createDirectory`, `workspace.listFiles`, `workspace.searchFiles`를 추가했으며, 빌드된 VSIX에 `Sidecar/cline-sidecar.js`, `Sidecar/infrastructure/host/VisualStudioHostBridgeClient.js`, `Sidecar/infrastructure/host/VisualStudioHostProvider.js`, `Sidecar/infrastructure/transport/JsonRpcConnection.js`가 포함되는 것을 확인했다.
- [2026-05-30] Phase 2/3 진행: `src/sidecar/src/presentation/webview/VisualStudioWebviewRouter.ts`를 추가해 WebView gRPC routing을 `main.ts`에서 분리했다. sidecar가 `UiService.openUrl`, `WebService.openInBrowser`, `WebService.checkIsImageUrl`, `WebService.fetchOpenGraphData`, `StateService.getAvailableTerminalProfiles`, account auth status stream 같은 무상태/저위험 서비스를 직접 처리하며, task/state lifecycle은 아직 C# fallback에 남긴다. VSIX에 `Sidecar/presentation/webview/VisualStudioWebviewRouter.js` 포함을 확인했다.
- [2026-05-30] Phase 3/4 대형 진전: upstream Cline 3.86.0 standalone core 방식으로 `cline-core.js` 실행까지 검증했으나, 사용자의 최종 목표에 맞춰 이 경로는 폐기하고 `@cline/sdk` 직접 embedding 방식으로 전환했다.
- [2026-05-30] Phase 4 전환: sidecar에 `@cline/sdk@0.0.42`를 설치하고 `ClineSdkRuntime`을 추가했다. VSIX는 Node 22.15.0 `Sidecar/node.exe`와 `Sidecar/node_modules/@cline/sdk`를 포함하며, `ClineCore.create({ backendMode: "local" })`가 packaged Sidecar 위치에서 성공한다.
- [2026-05-30] Phase 4 진행: `sdk.status`, `sdk.start`, `sdk.startSession`, `sdk.send`, `sdk.stopSession`, `sdk.listHistory`, `sdk.dispose` JSON-RPC를 추가했다. 과거 `upstream.*` 메서드는 호환 alias로 SDK 런타임을 호출한다.
- [2026-05-30] Phase 4 정리: 이전 standalone runtime 산출물인 `src/sidecar/src/upstream`, `artifacts/Sidecar/upstream`, `artifacts/Sidecar/upstream-core`, `copy-upstream-core.js`를 제거했다.
- [2026-05-30] Phase 4/5 진행: SDK API 노출 범위를 `getSession`, `readMessages`, `deleteSession`, `updateSession`, `getUsage`, `restore`, `settings.list`, `settings.toggle`로 확장했다. WebView의 task history/delete/show, checkpoint restore, rules/workflows/skills refresh/toggle은 가능한 경우 SDK API를 우선 사용한다.
- [2026-05-30] UI 정리: WebView state에 `vsClineSdkCoverage`를 추가하고 TaskHeader에 SDK coverage strip을 표시한다. Visual Studio 2022 17.12에서 직접 포팅 불가능하거나 VS host adapter가 필요한 항목은 `Vs2022SdkCoverage.md`에 별도 정리했다.
- [2026-05-30] Wrapper 경계 정리: ToolWindow의 C# `VisualStudioClineBridge` fallback을 제거하고 WebView 요청을 sidecar SDK로만 라우팅하도록 변경했다. `VsClineAgent.csproj`에서 legacy C# runtime(`Agent/*`, `Bridge/VisualStudioClineBridge.cs`, `SettingsService`, `AgentSettings`)을 컴파일 대상에서 제거했다. C#은 VSIX/WebView2/sidecar lifecycle/Visual Studio host adapter 역할만 맡는다.

## 성공 기준

이 포팅이 제대로 되었다고 말하려면 최소한 다음이 되어야 한다.

- upstream Cline의 Task runtime을 C# 재작성 없이 사용한다.
- VSIX sidecar가 `@cline/sdk`의 `ClineCore`를 직접 로드한다.
- upstream src/webview service contract를 Node sidecar가 처리한다.
- C# bridge에는 feature placeholder가 거의 없다.
- tool handler 목록이 upstream과 동일하다.
- terminal/checkpoint/MCP/browser/provider가 "보이는 UI"만 있는 상태가 아니라 실제 동작한다.
- upstream commit을 올렸을 때 VS host adapter 쪽 수정만으로 따라갈 수 있다.
