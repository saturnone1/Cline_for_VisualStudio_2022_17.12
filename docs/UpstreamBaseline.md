# Upstream Cline Baseline

## 기준

- Upstream working copy: `../cline-upstream-temp`
- Baseline commit: `5efa8cfd3f1746ad7dbe72fcdba31eeb7ad858c4`
- Upstream Cline package version: `3.86.0`
- SDK baseline: `@cline/sdk` 0.0.43
- Canonical host: Visual Studio 2022 공통 소스
- VSIX baseline version: `1.1.37`
- Runtime shape: C# VSIX host + WebView2 + named-pipe JSON-RPC + Node 22 sidecar + Cline SDK

## 현재 포팅 상태

- VSIX가 WebView2 도구 창을 열고 Node sidecar와 named-pipe JSON-RPC로 통신한다.
- WebView 메시지는 sidecar가 우선 처리하며, C# 호환 경계는 sidecar 미가동 오류와 passive subscription만 처리한다.
- Visual Studio host 기능은 workspace, window, environment, diff 등 집중된 host adapter를 통해 노출된다.
- Sidecar는 SDK session/event 정규화, typed WebView RPC, 상태 영속화와 기능별 vertical slice를 소유한다.
- 직접 `@cline/sdk` import는 `src/sidecar/src/infrastructure/sdk`에 한정된다.
- 공통 소스 한 벌에서 `packaging/vs2022-17.0`과 `packaging/vs2022-17.12` 프로필을 사용해 두 VSIX를 만든다.

## Upstream UI/UX 동등성

구현된 범위:

- Welcome, Home, Account, About 화면은 LIG VS 브랜딩을 사용하면서 task-first 흐름을 유지한다.
- Chat은 정규화된 SDK 메시지, command card, browser phase, tool activity, checkpoint, subagent/team progress를 렌더링한다.
- Settings는 provider 인증과 catalog, terminal, browser, MCP, rules, hooks, scheduled agent, plugin, worktree 설정을 제공한다.
- WebView는 상태를 렌더링하고 typed user intent만 전송하며 SDK, Visual Studio API, 영속화 정책을 직접 소유하지 않는다.

Visual Studio 전용 대체가 필요한 범위:

- VS Code shell integration, authentication provider API, WebView URI helper, marketplace install, inline comment와 command contribution point
- Visual Studio terminal pane의 세부 UX
- upstream SDK가 제공하지 않는 checkpoint diff stream

## SDK 도구 동등성

- 파일 read/write/list/search/edit/apply-patch는 SDK와 Visual Studio host adapter를 통한다.
- 명령 실행은 재사용 가능한 Visual Studio command-host session과 command card를 사용한다.
- MCP lifecycle과 resource/prompt metadata는 SDK API가 제공되면 이를 사용하고, 그렇지 않으면 명시적 진단을 제공한다.
- Browser/Web fetch는 사용자 설정과 policy를 거쳐 sidecar browser handler가 실행한다.
- Hook, scheduled agent, plugin, subagent, provider catalog와 OAuth 상태는 각각 feature handler 또는 adapter가 소유한다.

## 주요 제약

- Runtime source of truth는 `src/sidecar/src/infrastructure/sdk/ClineSdkRuntime.ts`와 패키징된 `@cline/sdk`다.
- `legacy/dotnet-agent`는 읽기 전용 역사 자료이며 컴파일하거나 새 기능을 추가하지 않는다.
- Node 22 이상과 패키징된 native module이 필요하다.
- Air-gap 배포를 지원한다. 온라인 MCP marketplace 설치는 비활성화하며 Web fetch/browser는 사용자 설정으로 제어한다.
- `*.vsix`, `bin/`, `obj/`, `artifacts/Sidecar/`는 생성물이다. `artifacts/WebApp/`만 VSIX 패키징 입력으로 추적하는 명시적 예외다.

## 최종 검증 명령

아키텍처 구현이 완료된 뒤 canonical 저장소 루트에서 실행한다.

```powershell
cd src/sidecar
npm ci
npm run check
npm test
npm run build
```

```powershell
cd src/webview
npm ci
npm test
npm run build
```

```powershell
cd ../..
.\scripts\Build-VsixVariants.ps1 -Configuration Release
```

생성된 두 VSIX는 `scripts/Test-VsixPackage.ps1`가 manifest identity, installation range, 공통 payload와 sidecar/WebView 자산을 검증한다.
