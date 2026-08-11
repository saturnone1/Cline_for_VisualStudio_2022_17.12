# Runtime Regression Baseline

This document is the verification baseline for runtime failures reported against LIG VS 2.2.6 before the Cline SDK 0.0.66 upgrade. An item is complete only when its acceptance checks pass. Do not close an item merely because an SDK upgrade changes the visible symptom.

## Verification status

| Item | Automated status | Remaining manual evidence |
| --- | --- | --- |
| SDK upgrade | 0.0.66 exact; Sidecar, WebView, host, contracts, both VSIX runtime smoke pass | Provider-backed conversation smoke |
| COMP-01 | SDK 0.0.66 native automatic compaction and configured model limits are wired | Long provider-backed transcript |
| COMP-02 | SDK compaction status and normal task cancellation are independently projected | Cancel during a live provider request |
| UI-01 | GFM table render regression passes | History/resumed transcript visual check |
| TOOL-01 | SDK 0.0.66 schema repair plus model-visible failure boundary tests pass | Weak-model malformed call sample |
| TOOL-02 | MCP failure context and recovery tests pass | Disconnected/invalid MCP live sample |
| ATTACH-01 | Continued-task transport/display separation and image/file UI tests pass | History hydration visual check |
| HOST-01 | F5 shortcut policy and host tests pass | Visual Studio WebView focus smoke |
| TERM-01 | Process ownership, cancellation, output retention, shutdown tests, and explicit output-surface routing pass | Visual Studio 17.0/17.12 manual output-pane check |

## Upgrade boundary

- Previous baseline: `@cline/sdk`, `@cline/core`, and `@cline/llms` 0.0.43.
- Current version: exact `@cline/sdk` 0.0.66, with resolved `@cline/core` and `@cline/llms` 0.0.66.
- Context compaction is owned by SDK 0.0.66. The LIG VS setting enables or disables SDK automatic compaction; LIG VS does not create a replacement session for manual compaction.
- Preserve the LIG VS WebView, host process ownership, Visual Studio RPC, approval, and task-lifecycle boundaries.
- Prefer schema-driven normalization and model-visible tool failures. Do not add per-model or per-tool-value patches for individual malformed examples.

## COMP-01: Long context compaction stalls or times out

### Evidence

- UI progressed through `Summarizing conversation (7/23)` and then stopped advancing.
- Other attempts logged `Context compaction source part 1/1 timed out after 30000ms`.
- The host and sidecar reported the same unary compaction request as slow for about 30 seconds.
- A normal first assistant response in the affected environment took about 112 seconds, so a 30-second compaction request budget was insufficient for that provider.

### Ownership and upgrade impact

- SDK 0.0.66 calculates the full provider request, including system prompt and tool definitions, before deciding whether to compact.
- The configured model context window is supplied through SDK `modelInfo`, so local and custom providers do not fall back to an unrelated default limit.
- SDK session compaction state remains attached to the existing session and is reused on subsequent turns.

### Implemented

- The custom chunk summarizer, manual confirmation UI, replacement-session flow, and overflow retry were removed.
- SDK automatic compaction progress is projected as transient UI state rather than chat transcript content.
- Legacy compact RPC calls only enable SDK automatic compaction for compatibility with an older WebApp.

### Acceptance

- Long transcripts either compact inside the active SDK session or return the SDK/provider error through the normal task error path.
- Cancelling uses the same SDK run cancellation path and does not need to roll back a replacement session.
- Background terminal processes do not block compaction; their lifetime is managed independently.
- Repeated compaction reuses SDK-persisted session compaction state plus conversation added after its source boundary.

## COMP-02: Compaction cancellation waits behind the active request

### Evidence

- Pressing Cancel only disabled the button; leaving and reopening the session was required before cancellation appeared complete.

### Current mitigation

- Compaction is part of the SDK model-request pipeline, so Cancel and Back cancel the owning task rather than a second LIG VS compaction RPC.
- UI compaction state is cleared by assistant, completion, failure, and cancellation lifecycle events.

### Acceptance

- Cancel and Back interrupt compaction immediately in both Visual Studio variants.
- The UI leaves the compacting state without requiring navigation or restart.
- No replacement compaction session is created.

## UI-01: Markdown table crashes the WebView renderer

### Evidence

- `WebApp script failed: unhandledrejection: Cannot handle unknown node 'table'`.

### Ownership and upgrade impact

- This is a LIG VS WebView Markdown pipeline failure, not evidence that model summarization itself failed.
- SDK upgrade is not expected to fix the renderer.

### Implemented

- The shared Markdown renderer uses GFM and has an executable table regression test.

### Acceptance

- GitHub-flavored Markdown tables render in normal, resumed, compacted, and history transcripts.
- Unknown Markdown nodes fall back to bounded text instead of rejecting the render tree.
- A renderer failure cannot leave task or compaction state stuck.

## TOOL-01: Structured tool arguments arrive as JSON strings

### Evidence

- `run_commands.commands` and `read_files.files` were arrays serialized as strings.
- Some weak-model output combined a field name and value, such as `start_line: 90`, or over-escaped Windows paths.
- Validation rejected the calls before execution and raw validator JSON was shown in the conversation.

### Ownership and upgrade impact

- SDK 0.0.56 adds schema-driven repair for malformed or slightly incorrect tool arguments.
- SDK 0.0.58 adds `read_files` range repair.
- SDK 0.0.55 advertises run commands as shell strings.
- These changes are direct upgrade candidates and must be characterized before adding LIG VS normalization.

### Implemented

- SDK 0.0.66 supplies schema-driven repair for supported JSON-like command and file inputs.
- LIG VS keeps ambiguous inputs rejected and projects executor failures back to the model.

### Acceptance

- Supported JSON-like arguments are normalized from the declared schema, not by model-specific rules.
- Unsafe or ambiguous input remains rejected without execution.
- Validation failures are returned to the model as tool results so it can correct and retry.
- The WebView shows one concise failure summary and does not duplicate raw payloads.

## TOOL-02: MCP argument validation failures do not recover

### Evidence

- `mcp-vs2022__editor_replace` received `old_text` and `new_text` while its contract required `oldText` and `newText`.
- The validation error was displayed, but the model was not reliably given a recovery turn.

### Ownership and upgrade impact

- Confirm that the MCP server schema reaches the model unchanged.
- SDK schema normalization may help JSON-like values, but external MCP field aliases must not be guessed or silently executed.

### Acceptance

- The model receives the canonical MCP input schema.
- Pre-execution failures return a bounded, model-visible error containing the invalid paths and expected types.
- The turn remains active for a corrected call or a normal explanatory response.

## ATTACH-01: User attachments render as transcript text

### Evidence

- Images and files were displayed as `Attachments: Image: [attached image/png]` or equivalent text instead of the attachment UI used by the composer.

### Ownership and upgrade impact

- SDK 0.0.60 fixes image-start initialization and newer events retain `userImages` and `userFiles`.
- LIG VS must preserve display metadata separately from the bounded model prompt.

### Implemented

- Continued conversations now persist the original prompt and attachment arrays for UI rendering while keeping the bounded transport envelope internal.

### Acceptance

- User image messages show a thumbnail and open an enlarged view.
- User file messages show a file item with name and type.
- The same representation survives history hydration and session replacement.
- Data URLs, secrets, and internal prompt wrappers are not rendered as message text.

## HOST-01: F5 reloads WebView instead of starting Visual Studio debugging

### Evidence

- With focus in LIG VS, F5 refreshes WebView2 while Visual Studio debugging works normally outside the WebView.

### Ownership and upgrade impact

- This belongs to the C# WebView2 host accelerator-key boundary and is independent of the SDK upgrade.

### Implemented

- F5, Ctrl+F5, and Shift+F5 route to the corresponding Visual Studio debug commands while unrelated accelerators remain available to WebView2.

### Acceptance

- F5 invokes Visual Studio `Debug.Start` when focus is in LIG VS.
- WebView refresh remains available only through an explicit diagnostic action.
- Other standard Visual Studio commands keep their normal routing.

## TERM-01: Shell execution is not sufficiently visible or owned

### Requirement

- Developer commands should execute through a visible Visual Studio terminal when the host supports it.
- Long-running commands must expose command, output, state, ownership, and a stop action.
- Cancel, task close, tool-window close, and Visual Studio shutdown must apply the documented process-lifetime policy.

### Implemented

- Developer commands run in the LIG-owned reusable command host, whose process tree participates in cancellation and Visual Studio shutdown.
- The command card exposes retained output and stop/continue actions.
- Opening or attaching to a command now activates the `VsCline Agent` output pane that receives the command stream. It no longer opens the unrelated Visual Studio terminal pane and implies that output was routed there.
- Visual Studio's terminal contract exists only as an installation-private brokered service and is not part of the NuGet VSSDK contract used by both supported variants. LIG VS therefore does not bind to that version-specific implementation.

### Acceptance

- `cmd`, PowerShell, and Bash output is visible in the LIG VS command card and the Visual Studio `VsCline Agent` output pane.
- Commands cannot report completion before validation and execution succeed.
- Intentionally persistent servers are distinguished from leaked background processes.
- Internal sidecar maintenance processes remain separate from developer command sessions.

## Performance evidence

- `webview.message.slow` and `webviewRpcSlow` are symptoms until attributed to a boundary.
- Long unary operations must not block cancellation, navigation, state streams, or unrelated settings RPCs.
- Tool payloads and media must remain bounded before persistence and model submission.

## Verification order

1. Upgrade SDK packages to exact 0.0.66 and run compile-time contract checks.
2. Run SDK event characterization and all sidecar tests.
3. Re-run TOOL-01, TOOL-02, and ATTACH-01 before adding product-side repair.
4. Build and smoke-test both VSIX variants.
5. Address remaining LIG VS-owned items in the order: tool failure projection, attachment rendering, F5 routing, terminal visibility.
6. Record evidence under each item before marking it complete.
