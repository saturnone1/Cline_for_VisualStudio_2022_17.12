- [2026-05-30] **진행 중인 구조 개선 및 기록**

### TaskState 구조 및 snapshot/restore 구현

- AgentController.cs에 `TaskState` 클래스를 추가하여 전체 agent runtime state(컨텍스트 히스토리, taskText, taskCompleted, mistakeCount 등)를 하나의 구조로 캡슐화함.
- `GetTaskStateSnapshot()` 메서드로 현재 상태를 객체로 추출, `RestoreTaskState(TaskState)`로 복원 가능.
- 이 구조는 upstream Cline의 TaskState/CheckpointManager와 유사하게, checkpoint/task snapshot에 전체 상태를 저장하고 복원하는 기반이 됨.
- 현재는 `_apiHistory`, `_taskText`, `_taskCompleted`, `_consecutiveMistakeCount`만 포함하지만, pendingAsk, approval 등도 확장 가능.

### 다음 단계(예정)

- Bridge에서 checkpoint/task snapshot에 TaskState를 직렬화하여 저장, restore 시 역직렬화하여 AgentController에 전달하는 경로 구현 예정.
- 이후 TaskResume hook 실행, CheckpointTracker/manager 구조 반영 등도 순차적으로 진행할 계획임.

---
# Port Fidelity Gaps

This repository aims to port upstream Cline behavior to Visual Studio 2022 17.12 with minimal semantic drift. This note tracks the main gaps still visible in the current port.

## Current Status

- Core agent loop is reasonably faithful: recursive request loop, XML tool parsing, SEARCH/REPLACE diff application, tool result reinjection.
- Host integration is still simplified versus upstream VS Code Cline.
- Granular auto-approval persistence and runtime enforcement are now wired in the VS port.
- Some newer bridge coverage is only file-system or placeholder level and should not be read as full feature parity with upstream runtime behavior.

### Already Processed In This Audit

- `SlashService.condense`, `SlashService.reportBug` now acknowledge the pending ask flow instead of falling through.
- Checkpoint-backed review actions and MCP management actions now return explicit unsupported payloads instead of silent empty success responses.
- Checkpoint-dependent review affordances no longer stay visible in the webview when checkpoints are unavailable; completion rows hide `View Changes`/`Explain Changes`, and checkpoint rows hide `Compare`/`Restore`.
- Checkpoints are no longer hard-disabled in published state. The VS bridge now creates shadow-git checkpoint commits for file-editing and completion boundaries, carries `lastCheckpointHash` / `isCheckpointCheckedOut` metadata on `clineMessages`, and wires `CheckpointsService.checkpointRestore`, `CheckpointsService.checkpointDiff`, and completion `View Changes` / `Explain Changes` through that reduced checkpoint path.
- Hooks no longer present active management in the UI; the VS port only exposes existing hook files for inspection until runtime support exists.
- Placeholder account actions now return explicit unsupported payloads for missing org selection, spend-limit requests, and Cline account login/logout flows.
- Upstream account comparison showed provider auth handlers depend on callback/OAuth infrastructure; the VS port now marks `requesty`, `openrouter`, `hicap`, and `openAiCodex` auth actions explicit unsupported instead of opening misleading fallback URLs.
- `AccountService.subscribeToAuthStatusUpdate` now mirrors upstream subscription semantics more closely by sending an immediate unauthenticated snapshot instead of staying completely silent.
- MCP subscriptions no longer emit immediate empty marketplace/server events; they now stay quiet unless the VS port can produce real data, which matches upstream more closely than pushing empty catalogs on subscribe.
- OpenRouter and LiteLLM model subscriptions no longer emit the configured local model catalog on subscribe; they now stay quiet unless the VS port can produce real provider-backed data.
- OCA account service calls no longer fall through silently: login/logout now return explicit unsupported payloads, and the auth subscription emits a minimal unauthenticated snapshot so the UI does not wait forever.
- Several user-facing state placeholders no longer return silent success: remote config refresh, favorite-model toggles, banner dismissal/version updates, and CLI installation now return explicit unsupported payloads.
- Telemetry/onboarding placeholders no longer return silent success: onboarding progress capture and telemetry setting updates now return explicit unsupported payloads.

## Overimplemented Or Speculative

- Rules, workflows, hooks, and skills now have bridge-side file CRUD and toggle state, but that does not automatically mean upstream-equivalent runtime behavior. The largest example is hooks: the runtime does not execute `PreToolUse`, `PostToolUse`, `TaskCancel`, or `TaskComplete` hooks yet, so the current UI has been reduced to inspecting existing hook files rather than managing active hook behavior.
- Global workflow and hook storage paths in the VS bridge are still local assumptions rather than upstream-verified locations. Rules and skills have documented locations upstream; workflows/hooks did not have equally clear path evidence in the upstream repo/docs during this pass.
- Several routable RPCs still create false affordances because the method exists in the bridge but the upstream dependency does not. Remaining examples are mostly inert UI event streams and panes whose backing services are still dataless.

## RPC Audit Snapshot

This is the current bridge status relative to the webview contract.

### Implemented Or Usable

- Core task flow: `TaskService.newTask`, `TaskService.askResponse`, `TaskService.clearTask`, `TaskService.cancelTask`, `TaskService.getTaskHistory`, `TaskService.getTotalTasksSize`, `TaskService.showTaskWithId`, `TaskService.deleteTasksWithIds`, `TaskService.deleteAllTaskHistory`, `TaskService.toggleTaskFavorite`, `TaskService.taskFeedback`
- Browser flow: `BrowserService.getDetectedChromePath`, `BrowserService.getBrowserConnectionInfo`, `BrowserService.testBrowserConnection`, `BrowserService.discoverBrowser`, `BrowserService.relaunchChromeDebugMode`
- Settings/state flow: `StateService.subscribeToState`, `StateService.updateSettings`, `StateService.updateAutoApprovalSettings`, `StateService.setWelcomeViewCompleted`, `StateService.resetState`, `StateService.getAvailableTerminalProfiles`
- Settings/state flow: `StateService.subscribeToState`, `StateService.updateSettings`, `StateService.updateAutoApprovalSettings`, `StateService.setWelcomeViewCompleted`, `StateService.resetState`, `StateService.getAvailableTerminalProfiles`, `StateService.updateTerminalConnectionTimeout`
- Model configuration flow: `ModelsService.updateApiConfigurationProto`, `ModelsService.updateApiConfiguration`, `ModelsService.getOllamaModels`; provider refresh/get calls remain reduced and are not provider-backed streams in the VS port
- Worktree read-only baseline: `WorktreeService.listWorktrees`, `WorktreeService.getWorktreeDefaults`, `WorktreeService.getWorktreeIncludeStatus`, `WorktreeService.createWorktreeInclude`, `WorktreeService.trackWorktreeViewOpened`
- File helpers: `FileService.copyToClipboard`, `FileService.selectFiles`, `FileService.openFile`, `FileService.openFileRelativePath`, `FileService.openImage`, `FileService.refreshRules`, `FileService.toggleClineRule`, `FileService.toggleCursorRule`, `FileService.toggleWindsurfRule`, `FileService.toggleAgentsRule`, `FileService.toggleWorkflow`, `FileService.createRuleFile`, `FileService.deleteRuleFile`, `FileService.refreshHooks`, `FileService.refreshSkills`, `FileService.createSkillFile`, `FileService.deleteSkillFile`, `FileService.toggleSkill`, `FileService.ifFileExistsRelativePath`, `FileService.getRelativePaths`, `FileService.searchFiles`, `FileService.searchCommits`, `FileService.openMention`, `FileService.openDiskConversationHistory`, `FileService.openFocusChainFile`
- First-pass account flow: `AccountService.getRedirectUrl`, `AccountService.getUserCredits`, `AccountService.getOrganizationCredits`
- Additional task helpers: `TaskService.exportTaskWithId`, `TaskService.cancelBackgroundCommand`
- Slash utility acknowledgements: `SlashService.condense`, `SlashService.reportBug`

### Explicitly Reduced Or Unsupported

- Checkpoint parity remains reduced versus upstream: the VS port now supports `CheckpointsService.checkpointRestore`, `CheckpointsService.checkpointDiff`, `TaskService.taskCompletionViewChanges`, and `TaskService.explainChanges`, but through a bridge-side shadow-git snapshot flow rather than upstream `TaskCheckpointManager` / `CheckpointTracker` parity. Inline diff comment streaming and full task-state/context-history restoration semantics remain only partially matched.
- MCP marketplace/server subscriptions currently register successfully but remain dataless in the VS port
- MCP management actions now return explicit unsupported payloads: `McpService.addRemoteMcpServer`, `McpService.openMcpSettings`, `McpService.updateMcpTimeout`, `McpService.restartMcpServer`, `McpService.deleteMcpServer`, `McpService.toggleToolAutoApprove`, `McpService.toggleMcpServer`, `McpService.authenticateMcpServer`, `McpService.downloadMcp`
- Placeholder account actions now return explicit unsupported payloads: `AccountService.getUserOrganizations`, `AccountService.setUserOrganization`, `AccountService.submitLimitIncreaseRequest`, `AccountService.accountLoginClicked`, `AccountService.accountLogoutClicked`
- Provider auth flows now return explicit unsupported payloads: `AccountService.requestyAuthClicked`, `AccountService.openrouterAuthClicked`, `AccountService.hicapAuthClicked`, `AccountService.openAiCodexSignIn`, `AccountService.openAiCodexSignOut`
- OCA account actions now return explicit unsupported payloads: `OcaAccountService.ocaAccountLoginClicked`, `OcaAccountService.ocaAccountLogoutClicked`; `OcaAccountService.ocaSubscribeToAuthStatusUpdate` emits only a minimal unauthenticated snapshot.
- Streaming model/MCP/account/UI events remain reduced versus upstream even when the RPC exists; `AccountService.subscribeToAuthStatusUpdate` now emits only a minimal unauthenticated snapshot rather than a live auth service stream.

### Still Missing Or Falling Through Default Empty Payloads

- Account actions still called by the webview but not yet fully implemented: real auth state propagation, OCA auth propagation, and spend-limit backend workflows beyond explicit unsupported placeholders

Why this matters: some missing unary handlers still fall through the bridge default case and return `{}`, and some newer handlers only expose storage or placeholder behavior. Both patterns avoid transport errors but are not equivalent to upstream behavior.

## Highest Value Gaps

### 1. MCP and service-management surfaces are still mostly non-functional

The WebView uses a grpc-style API surface, but several services are placeholders in [VsClineAgent/Bridge/VisualStudioClineBridge.cs](VsClineAgent/Bridge/VisualStudioClineBridge.cs).

- `McpService.subscribeToMcpMarketplaceCatalog` now mirrors upstream registration semantics more closely by not emitting an immediate empty catalog, but the VS port still never produces marketplace data.
- `McpService.subscribeToMcpServers` now avoids emitting an immediate empty server list, but the VS port still has no MCP hub to produce real server updates.
- `ModelsService.subscribeToOpenRouterModels` now avoids sending the configured local model catalog on subscribe, but the VS port still lacks upstream provider discovery and refresh-driven model events.
- `ModelsService.subscribeToLiteLlmModels` now avoids sending the configured local model catalog on subscribe, but the VS port still lacks upstream provider discovery and refresh-driven model events.
- `AccountService.getUserOrganizations` now returns an explicit unsupported payload with an empty `organizations` array.
- Upstream account provider auth handlers (`requesty`, `openrouter`, `hicap`, `openAiCodex`) rely on callback/OAuth infrastructure that the VS port does not implement, so those actions are now explicit unsupported rather than partial substitutes.
- Most `UiService.subscribeTo...` streams are accepted but have no emitted events from the bridge itself.

Why it matters: the webview still exposes upstream panes and actions for MCP, provider discovery, and some account/UI flows, but those panes are mostly non-functional in the VS port.

### 2. Terminal execution is not host-terminal aware

[VsClineAgent/Agent/Tools/ExecuteCommandTool.cs](VsClineAgent/Agent/Tools/ExecuteCommandTool.cs) launches `cmd.exe /c` directly and only returns captured stdout/stderr.

- Upstream Cline has a full terminal abstraction (`ITerminalManager`, `ITerminalProcess`, `CommandExecutor`, `CommandOrchestrator`) with reusable terminals, busy/idle tracking, shell-integration waits, output-line events, unretrieved output buffers, and completion metadata.
- Upstream supports both `vscodeTerminal` and `backgroundExec` execution modes, including “Proceed While Running” and background-command tracking; the VS port has only one-shot process execution with timeout/kill.
- Upstream can query terminal state (`getOrCreateTerminal`, `getTerminals`, `getUnretrievedOutput`, `isProcessHot`) and configure terminal behavior (`setTerminalReuseEnabled`, output line limit, default profile); the VS port exposes only a single synthetic profile and a transient active-process list.
- Output is mirrored to a VS output pane, not to a reusable host terminal session, so shell-integrated follow-up behavior and terminal lifecycle events do not exist.

Why it matters: upstream Cline's command execution model is stateful and interactive; this port currently treats commands as one-shot processes.

### 3. Provider/model discovery is reduced to local OpenAI-compatible/Ollama flow

[VsClineAgent/Agent/LlmClient.cs](VsClineAgent/Agent/LlmClient.cs) is intentionally focused on `/chat/completions` against a local OpenAI-compatible endpoint.

- `ModelsService.getOllamaModels` only echoes the configured model name
- OpenRouter and LiteLLM model subscriptions are now dataless unless real provider-backed data exists, but the VS port still lacks upstream remote/provider discovery
- Provider-specific capability metadata is absent

Why it matters: this is acceptable for air-gapped local use, but it is not equivalent to upstream Cline's broader provider surface.

### 4. Workspace model is effectively single-root

[VsClineAgent/Bridge/VisualStudioClineBridge.cs](VsClineAgent/Bridge/VisualStudioClineBridge.cs) stores one `_workspaceRoot` and starts tasks against that single root.

- State includes a `workspaceRoots` shape, but runtime behavior is single-root oriented
- External file checks are based on the single working directory

Why it matters: upstream workspace behavior is richer for multi-root scenarios.

### 5. Checkpoints are partially present; hook runtime and context compaction are not

The current C# port now has a reduced checkpoint path in the bridge, but it still lacks upstream-style checkpoint/task-state architecture and context compaction behavior. Rules, workflows, hooks, and skills are file-system backed in the bridge, but hook lifecycle execution itself is still not wired into the runtime.

- The VS bridge now stores checkpoint hashes on `clineMessages`, creates shadow-git commits for edit/completion boundaries, restores workspace state by resetting that shadow-git worktree, and opens diff files for checkpoint compare / completion review.
- `TaskService.explainChanges` is no longer a hard unsupported placeholder. It now opens the checkpoint diff, uses the configured local LLM to generate structured file/line explanation comments, and renders those comments back into the chat review card plus a markdown artifact. It still does not match upstream's inline diff comment streaming or multi-file comment-controller experience.
- Upstream `UserMessage` editing routes still rely on restoring task/workspace state through checkpoint metadata; the local `webview-ui/src/components/chat/UserMessage.tsx` can now call into a real restore path, and the VS bridge now captures restore-relevant task metadata on checkpointed messages, including task prompt, completion/resume state, a checkpoint-time `currentTaskItem` snapshot with model/workspace metadata, and checkpoint-time resume seeds. Restore rewinds that metadata plus the immediate completion/resume state, including completed-task resume asks, to the restored checkpoint before resuming, and it also clears active request/background-running flags during restore. In-memory task snapshots now also preserve the pending ask type, the pending ask payload, and API-history seed instead of collapsing reopen/history flows back to generic `resume_*` asks plus reconstructed history, and reopening a task now also clears stale runtime progress flags while snapshotting and stopping any different active task before showing the selected snapshot and restoring its saved workspace root into runtime state. Resume no longer creates a fresh task/history item, checkpoint/task snapshots now preserve any `conversationHistoryDeletedRange` already present on the message stream, and the local agent loop now prefers checkpoint-captured `AgentController` API history when available, falling back to checkpoint-captured reconstructed chat history that includes original task attachment context, explain-changes review context, preserved tool-call intent metadata for tool-result turns, richer follow-up / approval ask payload reconstruction, and attachment summaries folded into task / ask-response text before handing control back to the reduced local runtime. Compared directly with upstream `Controller.initTask`, `Task.resumeTaskFromHistory`, `TaskState`, and checkpoint restore code, the VS port still does not restore persisted context-history state or the broader `TaskState` streaming/presentation/tool-use fields, run `TaskResume` hooks, or provide upstream `CheckpointTracker` / checkpoint-manager runtime internals.
- The local settings UI still lists the upstream `Checkpoints` feature toggle in `webview-ui/src/components/settings/sections/FeatureSettingsSection.tsx`, and the VS bridge now persists and enforces that toggle. The remaining gap is upstream checkpoint/runtime parity, not a dead setting control.

Why it matters: long-running task resilience is still weaker than upstream, checkpoint semantics still drift around resume/context restoration and explain-changes UX, and the hooks UI currently over-promises behavior because hook files can be created and toggled without ever being executed.

## False Affordances

- Hooks: runtime lifecycle execution does not exist yet. The VS port now exposes existing hook files for inspection, but create, toggle, and delete actions are disabled to avoid pretending the feature is active.
- MCP marketplace/server panes: routable and visible in the webview, but still lack real marketplace/server data in the VS port.
- The settings UI exposes a working `Checkpoints` toggle, but the VS port still implements reduced checkpoint parity rather than upstream checkpoint/runtime parity.
- `webview-ui/src/components/chat/UserMessage.tsx` now reaches a real checkpoint restore path, and that path rewinds checkpoint-captured task metadata plus a checkpoint-time task item snapshot and immediate resume/completion state, including completed-task resume asks, while clearing active request/background-running flags. In-memory task reopen/history flows also preserve the saved ask type and API-history seed more faithfully, clear stale runtime progress flags when reopening snapshots, snapshot and stop any different active task before switching, restore the snapshot's saved workspace root into runtime state, and keep the same task/history item instead of creating a fresh one while also seeding the local agent loop from checkpoint-captured API history when available, otherwise from checkpoint-captured reconstructed message history that includes original task attachments, explain-changes review context, tool-call intent for tool-result turns, and richer follow-up / approval ask details. The remaining gap is that resume still follows the VS port's simplified local agent restart semantics rather than upstream task-state/context-history restoration.
- `UiService.subscribeToMcpButtonClicked`, `UiService.subscribeToHistoryButtonClicked`, `UiService.subscribeToChatButtonClicked`, `UiService.subscribeToSettingsButtonClicked`, `UiService.subscribeToWorktreesButtonClicked`, `UiService.subscribeToPartialMessage`, `UiService.subscribeToAccountButtonClicked`, `UiService.subscribeToRelinquishControl`, `UiService.subscribeToShowWebview`, and `UiService.subscribeToAddToInput` are accepted by the bridge but remain inert because the VS port has no local sender infrastructure for them. They are intentionally not converted to hard stream errors because the webview eagerly subscribes to them during startup and currently treats failures as console errors.

## Bridge Service Map

### Streaming

- Implemented: `StateService.subscribeToState`
- Registered but dataless: `ModelsService.subscribeToOpenRouterModels`, `ModelsService.subscribeToLiteLlmModels`
- Registered but dataless: `McpService.subscribeToMcpMarketplaceCatalog`, `McpService.subscribeToMcpServers`
- Minimal initial payload only: `AccountService.subscribeToAuthStatusUpdate`
- Minimal initial payload only: `OcaAccountService.ocaSubscribeToAuthStatusUpdate`
- Accepted but intentionally inert: `UiService.subscribeToMcpButtonClicked`, `UiService.subscribeToHistoryButtonClicked`, `UiService.subscribeToChatButtonClicked`, `UiService.subscribeToSettingsButtonClicked`, `UiService.subscribeToWorktreesButtonClicked`, `UiService.subscribeToPartialMessage`, `UiService.subscribeToAccountButtonClicked`, `UiService.subscribeToRelinquishControl`, `UiService.subscribeToShowWebview`, `UiService.subscribeToAddToInput`

### Unary

- Implemented enough for core chat flow: `UiService.initializeWebview`, `UiService.openUrl`, `StateService.updateSettings`, `StateService.updateAutoApprovalSettings`, `ModelsService.updateApiConfigurationProto`, `ModelsService.getOllamaModels`, `TaskService.*`, `FileService.copyToClipboard`, `FileService.selectFiles`, `FileService.openFile`, `FileService.openFileRelativePath`
- Placeholder or reduced behavior: `UiService.onDidShowAnnouncement`, `StateService.getAvailableTerminalProfiles`, `WebService.fetchOpenGraphData`, `AccountService.getUserOrganizations`, `AccountService.setUserOrganization`, `AccountService.submitLimitIncreaseRequest`, `AccountService.accountLoginClicked`, `AccountService.accountLogoutClicked`, `OcaAccountService.ocaAccountLoginClicked`, `OcaAccountService.ocaAccountLogoutClicked`, provider auth handlers that are now explicit unsupported because upstream callback/OAuth infrastructure is absent

## Suggested Next Steps

1. Re-audit every bridge method that currently returns `{}` or a no-op success payload, and either port the upstream behavior or mark it explicit unsupported.
2. Decide whether hook management should remain exposed before hook runtime exists; if it stays, document clearly that hooks are currently inert.
3. Replace MCP and provider discovery stubs with real backing state, or suppress those upstream UI affordances in the VS port.
4. Rework command execution around a persistent Visual Studio terminal abstraction.
5. Bring the reduced checkpoint flow closer to upstream by extending the current partial task-state/context rewind into fuller restoration semantics and by adding real explain-changes diff comment streaming.