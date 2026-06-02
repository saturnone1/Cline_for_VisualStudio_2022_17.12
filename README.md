# Cline for Visual Studio 2022 17.12

Visual Studio 2022에서 Cline을 사용할 수 있도록 포팅한 VSIX 프로젝트입니다.

이 저장소의 현재 방향은 Cline 에이전트 런타임을 C#으로 다시 구현하는 것이 아니라, `@cline/sdk`를 Node sidecar에서 실행하고 Visual Studio 확장은 WebView2 UI, 프로세스 수명주기, named-pipe JSON-RPC, Visual Studio 호스트 어댑터를 제공하는 것입니다.

## 프로젝트 개요

- 확장 이름: `VS AI Agent (Cline Port)`
- 대상 IDE: Visual Studio 2022 17.x amd64
- VSIX 프로젝트: `VsClineAgent/VsClineAgent.csproj`
- 대상 프레임워크: .NET Framework 4.7.2
- 런타임 구조: Visual Studio VSIX + WebView2 + Node sidecar + `@cline/sdk`
- 주요 용도: Visual Studio 안에서 Cline 스타일의 채팅, 파일 읽기/수정, 검색, 명령 실행, 작업 기록, 일부 MCP/체크포인트 기능 사용
- 오프라인/폐쇄망 방향: WebView2 Fixed Version Runtime, Node 런타임, SDK 의존성, NuGet 패키지를 VSIX 또는 로컬 패키지로 번들링

## 저장소 구조

```text
.
├─ VsClineAgent/            # Visual Studio VSIX host, WebView2 tool window, VS host adapters
├─ sidecar/                 # Node sidecar TypeScript source, @cline/sdk integration
├─ webview-ui/              # React/Vite 기반 Cline WebView UI
├─ src/shared/              # WebView와 sidecar가 공유하는 Cline 타입/유틸 일부
├─ LocalPackages/           # 폐쇄망 빌드용 NuGet 패키지 캐시
├─ scripts/                 # 패키지 다운로드, WebView2 번들링, 설치 정리 스크립트
├─ VS2022-SDK-COVERAGE.md   # 현재 구현 상태와 parity backlog의 기준 문서
└─ AIR-GAP-BUILD.md         # 폐쇄망 빌드/설치 참고 문서
```

## 빌드 준비

필수 구성:

- Visual Studio 2022 17.x
- Visual Studio extension development 워크로드
- .NET Framework 4.7.2 Developer Pack
- Node.js 22 이상(개발/빌드용)
- WebView2 Runtime 또는 WebView2 Fixed Version Runtime
- 인터넷 연결이 없는 환경에서는 `LocalPackages/`, WebView2 Fixed Runtime, sidecar `node_modules.zip` 준비 필요

NuGet 패키지를 로컬 캐시에 내려받으려면 인터넷이 되는 PC에서 다음을 실행합니다.

```powershell
.\scripts\Download-Packages.ps1
```

WebView2 Fixed Version Runtime을 VSIX에 포함하려면 다음 중 하나를 실행합니다.

```powershell
.\scripts\Bundle-WebView2Runtime.ps1 -SourceCab "D:\offline\Microsoft.WebView2.FixedVersionRuntime.<version>.x64.cab"
```

```powershell
.\scripts\Bundle-WebView2Runtime.ps1 -SourceRuntime "D:\offline\Microsoft.WebView2.FixedVersionRuntime.<version>.x64"
```

## 빌드

sidecar 빌드:

```powershell
cd sidecar
npm install
npm run build
```

WebView UI 빌드:

```powershell
cd webview-ui
npm install
npm run build
```

VSIX 빌드:

```powershell
msbuild VsClineAgent.sln /p:Configuration=Release /restore /p:RestorePackagesPath=.\LocalPackages
```

빌드 결과는 일반적으로 다음 위치에 생성됩니다.

```text
VsClineAgent/bin/Release/VsClineAgent.vsix
```

## 실행

1. `VsClineAgent.vsix`를 설치합니다.
2. Visual Studio 2022를 다시 시작합니다.
3. 메뉴에서 `View > AI Agent` 도구 창을 엽니다.
4. 설정에서 사용할 LLM provider와 모델을 지정합니다.

설치된 VSIX를 실행할 때 사용자가 별도로 Node.js를 설치할 필요는 없습니다. VSIX는 sidecar용 Node 런타임과 SDK 의존성을 패키징해서 실행하는 것을 목표로 하며, Node.js 22 이상은 sidecar를 다시 빌드하거나 개발할 때 필요합니다.

로컬 Ollama 예시:

```text
Base URL: http://localhost:11434/v1
Model: qwen3-coder:latest
```

## 구현 상태

### 구현됨

- Visual Studio VSIX 패키지와 Tool Window 등록
- WebView2 기반 Cline UI 호스팅
- Node sidecar 프로세스 실행과 종료 관리
- named-pipe JSON-RPC 기반 C# host와 sidecar 통신
- `@cline/sdk` 기반 ClineCore local backend 실행
- SDK session 시작, 전송, 중단, 조회, 수정, 삭제
- SDK message/history 읽기와 WebView 상태 hydration
- SDK 이벤트를 WebView 메시지/부분 메시지로 정규화
- 도구 승인 요청을 WebView 승인 UI로 연결
- follow-up question UI와 사용자 응답 대기
- Visual Studio workspace 기준 파일 읽기, 쓰기, 검색, 목록 조회
- `.clineignore`를 고려한 자동 파일 검색/목록 처리
- `apply_patch`/editor 계열 수정 결과 추적과 변경 카드 표시
- Visual Studio diff 열기
- 명령 실행 host adapter
- reusable `cmd.exe` command session, command id, terminal id, UTF-8 codepage 설정
- 명령 취소, 장기 실행 명령 감지, 최근/미수거 출력 조회
- SDK settings 기반 rules, workflows, skills 목록/토글 일부
- SDK checkpoint restore 일부
- MCP settings-file 기반 서버 등록, 목록, 연결, tool discovery, toggle, timeout, restart, delete 일부
- WebView 초기 렌더를 위한 안전한 C# 초기 상태 제공
- `%LOCALAPPDATA%\VsClineAgent\logs` 아래 상호작용 진단 로그 기록
- 폐쇄망 배포를 위한 WebView2 Fixed Runtime 번들링 경로
- sidecar Node 의존성을 `node_modules.zip`으로 패키징하고 최초 실행 시 로컬 확장

### 부분 구현

- 명령 실행: 실제 명령 실행과 출력 카드는 동작하지만 Visual Studio 터미널 pane과 완전 통합되지는 않았습니다.
- 체크포인트: SDK restore 경로는 있으나 diff/review/undo parity는 제한적입니다.
- MCP: settings-file 서버와 SDK tool 연결은 일부 지원하지만 marketplace 설치, OAuth callback, resource/prompt listing은 완전하지 않습니다.
- Browser/web fetch: 폐쇄망을 고려해 `fetch_web_content`는 기본 비활성화이며, `VSCLINE_ENABLE_WEB_FETCH=1`일 때만 제한적으로 사용합니다. Chrome debugging 기반 browser action adapter는 아직 필요합니다.
- Provider/model catalog: 로컬 API 설정은 가능하지만 원격 catalog refresh와 OAuth 기반 provider 설정은 축소되어 있습니다.
- Account/auth: 인증되지 않은 상태 snapshot은 가능하지만 VS Code authentication provider와 같은 흐름은 Visual Studio에서 별도 구현이 필요합니다.
- Rules/workflows/skills: 설정 조회/토글은 일부 가능하지만 `skills` 실행 도구는 승인/실행 UX가 완성될 때까지 비활성화 상태입니다.
- Worktree 서비스: WebView RPC stub/reduced response 중심입니다.

### 미구현 또는 주요 남은 작업

- Visual Studio 터미널 pane과의 first-class 통합
- 장기 실행 명령에 대한 proceed while running, attach, continue UX
- 파일 변경 Review, Undo, Revert, multi-file review의 upstream 수준 parity
- checkpoint diff/review metadata와 transcript UX
- Chrome debugging adapter 기반 browser action
- Web fetch/browser lifecycle 상태 표시
- MCP marketplace catalog/install
- MCP OAuth authenticate callback
- MCP resource, resource-template, prompt listing
- Visual Studio 호환 OAuth/account login/logout flow
- OpenRouter, Requesty, Hicap, OpenAI Codex 등 provider auth flow parity
- provider/model catalog stream과 capability metadata refresh
- worktree create, switch, merge, delete, conflict 처리
- Visual Studio solution reload와 worktree 전환 연동
- hooks lifecycle 실행
- scheduled agents/cron automation
- plugin install/configuration surface
- subagent/team 실행 상태와 승인 UX

## 런타임 경계

C# VSIX가 담당하는 것:

- Visual Studio 확장 package 초기화
- Tool Window와 WebView2 호스팅
- Node sidecar lifecycle 관리
- named-pipe JSON-RPC transport
- workspace, editor, command execution, diff, clipboard, storage, secrets 등 Visual Studio host adapter
- WebView2 Runtime과 sidecar runtime 준비

Node sidecar와 `@cline/sdk`가 담당하는 것:

- ClineCore session lifecycle
- agent loop와 tool semantics
- streaming/event normalization
- SDK tool approval flow
- SDK settings, history, checkpoint, MCP manager 연동
- WebView service/RPC routing

새 기능을 추가할 때 C#에 agent runtime을 다시 만들지 말고, 가능한 한 sidecar와 SDK/host adapter 경계에 추가해야 합니다.

## 참고 문서

- `VS2022-SDK-COVERAGE.md`: 현재 구현 상태, parity gap, 작업 우선순위
- `PORT-FIDELITY-GAPS.md`: 이전 gap 문서에서 현재 기준 문서로 가는 포인터
- `UPSTREAM_BASELINE.md`: upstream 기준 정보
- `AIR-GAP-BUILD.md`: 폐쇄망 빌드와 설치 참고
- `sidecar/README.md`: sidecar 개발 참고
