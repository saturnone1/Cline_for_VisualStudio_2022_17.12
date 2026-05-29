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
```
VsClineAgent/
├── VsClineAgent.csproj          # net472, LangVersion=latest, Nullable=enable
├── VsClineAgentPackage.cs       # AsyncPackage 진입점
├── Guids.cs                     # Package/Command/Window GUID 상수
├── VsClineAgentPackage.vsct     # 메뉴 커맨드 정의 (View 메뉴 → AI Agent)
├── source.extension.vsixmanifest
│
├── Agent/                       # 핵심 에이전트 로직 (Cline 포트)
│   ├── AgentController.cs       # 메인 에이전트 루프 (Task.startTask 포트)
│   ├── LlmClient.cs             # Ollama/OpenAI 호환 HTTP 클라이언트
│   ├── AssistantMessage/
│   │   ├── AssistantMessageTypes.cs   # ToolUse, TextStreamContent, ClineToolNames
│   │   ├── AssistantMessageParser.cs  # parseAssistantMessageV2 포트 (XML 파싱)
│   │   └── DiffApplier.cs             # constructNewFileContentV1 포트 (SEARCH/REPLACE)
│   ├── Models/
│   │   ├── ChatMessage.cs       # ChatMessage, ChatRequest, ChatResponse (plain text)
│   │   └── LlmModels.cs        # 빈 파일 (구 OpenAI function-calling 클래스 제거됨)
│   ├── Prompts/
│   │   ├── SystemPrompt.cs      # Cline 시스템 프롬프트 전체 (agent_role, rules, tools 등)
│   │   └── FormatResponse.cs    # formatResponse 포트 (noToolsUsed, toolError 등)
│   └── Tools/
│       ├── IAgentTool.cs        # IAgentTool, IToolCallbacks 인터페이스
│       ├── ToolRegistry.cs      # 툴 등록/디스패치
│       ├── ReadFileTool.cs      # read_file (N | line 포맷)
│       ├── WriteFileTool.cs     # write_to_file (디렉토리 자동 생성, 승인 요구)
│       ├── ReplaceInFileTool.cs # replace_in_file (DiffApplier 사용)
│       ├── ListFilesTool.cs     # list_files (재귀 옵션)
│       ├── SearchFilesTool.cs   # search_files (regex, 컨텍스트 2줄)
│       ├── ExecuteCommandTool.cs # execute_command (cmd.exe 래퍼)
│       ├── ListCodeDefinitionsTool.cs # list_code_definition_names (regex 기반)
│       ├── AskFollowupQuestionTool.cs # ask_followup_question
│       ├── AttemptCompletionTool.cs   # attempt_completion (루프 종료 신호)
│       └── ToolResult.cs        # 빈 파일 (placeholder)
│
├── Commands/
│   └── OpenChatWindowCommand.cs # View 메뉴 → AI Agent 커맨드
│
├── ToolWindows/
│   ├── ChatToolWindow.cs        # ToolWindowPane (AI Agent 창)
│   ├── ChatToolWindowControl.xaml     # WPF UI (WebView2 + 로딩/에러 패널)
│   └── ChatToolWindowControl.xaml.cs  # WebView2 브릿지, AgentController 연동
│
├── Services/
│   ├── AgentSettings.cs         # 설정 모델 (LlmBaseUrl, ModelName, ApiKey 등)
│   ├── SettingsService.cs       # JSON 파일 기반 설정 저장/로드
│   └── VsEditorService.cs       # VS DTE2 API 래퍼 (파일, 솔루션, 진단)
│
└── WebApp/                      # 채팅 UI (WebView2로 렌더링)
    ├── index.html
    ├── app.js                   # 에이전트 이벤트 핸들러, UI 렌더링
    └── styles.css               # VS 다크테마 스타일
```

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
