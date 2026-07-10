# VsClineAgent — Claude Code 가이드

## 프로젝트 개요
Visual Studio 2022 17.12용 VSIX 확장. Cline AI 코딩 에이전트(https://github.com/cline/cline.git)를 C# .NET Framework 4.7.2로 포팅.
- **에어갭 호환**: Ollama 등 로컬 LLM (OpenAI 호환 API) 사용
- **아키텍처**: Cline 원본과 동일. XML 기반 툴 호출, SEARCH/REPLACE diff, 재귀 에이전트 루프

## 빌드 환경 (Windows only)
```
Visual Studio 2022 17.12 + VSSDK 확장 워크로드
msbuild VsClineAgent.sln /p:Configuration=Release
```
- **Linux 서버에서는 빌드 불가** (net472 + Microsoft.VisualStudio.SDK 17.6 요구)
- 코드 편집은 Linux 서버에서 가능, 빌드/설치는 Windows에서

## 프로젝트 구조
```text
src/
├── extension/    # C# VSIX host, ToolWindow, Visual Studio adapters
├── src/sidecar/      # Node runtime and @cline/sdk integration
├── shared/       # shared TypeScript contracts and utilities
└── webview/      # React/Vite WebView UI

assets/           # source-controlled static assets
artifacts/        # generated WebApp and Sidecar package inputs
docs/             # architecture and deployment documentation
scripts/          # build, validation, and cleanup scripts
vendor/           # offline NuGet feed and optional WebView2 runtime
```

VSIX 내부에서는 호환성을 위해 `Assets/`, `WebApp/`, `Sidecar/`, `WebView2Runtime/` 경로를 유지하며, `src/extension/VsClineAgent.csproj`의 `Link` 항목이 저장소 경로와 패키지 경로를 연결합니다.

## 핵심 아키텍처 (Cline 포트)

### 에이전트 루프
```
StartTaskAsync(task, workspacePath)
  → RecursivelyMakeRequestsAsync(userMessages, ct, depth)
      1. _apiHistory에 user 메시지 추가
      2. [system prompt] + [history] → LLM 호출
      3. AssistantMessageParser.Parse() → TextStreamContent | ToolUse 블록들
      4. TextStreamContent: <thinking> 태그 제거 후 UI 전송
      5. ToolUse: _tools.ExecuteAsync() → 결과를 toolResultMessages에 추가
      6. attempt_completion → _taskCompleted = true, 루프 종료
      7. 툴 미사용 시: NoToolsUsed 에러 + consecutiveMistakeCount++
      8. toolResultMessages를 다음 user 턴으로 재귀 호출
```

### XML 툴 호출 포맷 (Cline 방식, OpenAI function_call 아님)
```xml
<read_file>
<path>src/main.cs</path>
</read_file>
```
LLM이 텍스트에 XML을 내포. `AssistantMessageParser`가 문자별 파싱.

### SEARCH/REPLACE diff 포맷 (replace_in_file)
```
------- SEARCH
기존 코드 (정확히 일치해야 함)
=======
새 코드
+++++++ REPLACE
```
3단계 매칭: exact → lineTrimmed → blockAnchor (DiffApplier.cs)

### 이벤트 시스템 (C# → WebApp)
| AgentEvent.Type | WebApp msg.type | 주요 필드 |
|----------------|-----------------|-----------|
| userMessage | userMessage | content |
| assistantText | assistantMessage | content |
| agentStatus | agentStatus | status |
| toolUseStarted | toolUse | toolCallId, toolName, arguments(JSON) |
| toolResult | toolResult | toolCallId, content, isError |
| awaitingApproval | awaitingApproval | toolCallId, toolName, arguments(JSON) |
| askUser | askUser | question, options[] |
| taskCompleted | taskCompleted | result |
| error | error | content |

### WebApp → C# 메시지
| msg.type | C# 핸들러 |
|----------|-----------|
| sendMessage | StartTaskAsync(content, workspaceRoot) |
| approveAction | SetApproval(true) |
| rejectAction | SetApproval(false) |
| userAnswer | SetUserInput(content) |
| stopAgent | Stop() |
| updateSettings | Save(settings) + UpdateSettings() |
| getSettings | Load() → settings 이벤트 |
| clearHistory | historyCleared 이벤트 (다음 StartTask에서 자동 초기화) |
| getWorkspaceContext | GetSolutionRootAsync + GetOpenDocumentsAsync |

## 설정 파일 경로 (런타임)
- 설정: `%APPDATA%\VsClineAgent\settings.json`
- WebView2 데이터: `%LOCALAPPDATA%\VsClineAgent\WebView2Data\`

## 기본 설정값
```json
{
  "LlmBaseUrl": "http://localhost:11434/v1",
  "ModelName": "qwen3-coder:latest",
  "ApiKey": "",
  "MaxTokens": 8192,
  "Temperature": 0.1,
  "AutoApprove": false
}
```

## 주의사항
- **LlmModels.cs, ToolResult.cs**: 빈 파일. 삭제하면 안 됨 (csproj 항목 없어서 괜찮긴 하지만)
- **AgentController.cs의 `AgentEvent` 이름 충돌**: 이벤트명과 타입명이 동일하지만 C# 문법상 유효
- **execute_command**: cmd.exe 사용 (Windows 전용). 리눅스 포팅 시 교체 필요
- **list_code_definition_names**: tree-sitter 대신 regex 기반. .cs/.ts/.js/.py/.java/.go 지원
- **AutoApprove=false 기본값**: 모든 파일 쓰기/실행 명령은 UI에서 승인 필요

## 의존성
```xml
Microsoft.VisualStudio.SDK       17.6.36389
Microsoft.VSSDK.BuildTools       17.6.2164
Microsoft.Web.WebView2           1.0.2739.15
Newtonsoft.Json                  13.0.3
```
