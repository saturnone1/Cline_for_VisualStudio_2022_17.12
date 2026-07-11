# Target Architecture

## Status

This document is the shared migration target for the Visual Studio 2022 17.0 and 17.12 products.
It does not claim that the current code already satisfies the target.

## Decision

LIG VS will evolve toward a modular monolith with:

- vertical slices for user-visible behavior;
- ports and adapters only at external boundaries;
- an explicit agent runtime with typed lifecycle events;
- typed contracts across WebView, Node, and .NET boundaries;
- a passive WebView;
- one common implementation that produces both VSIX variants.

Clean Architecture dependency direction remains useful, but technical layers must not scatter one feature across unrelated directories.

## Current evidence

The current runtime boundary is sound:

```text
WebView -> Visual Studio host -> named-pipe JSON-RPC -> Node sidecar -> @cline/sdk
```

The principal risks are:

- `VisualStudioWebviewBackend.ts` combines routing, sessions, transcript projection, providers, OAuth, MCP, worktrees, browser, hooks, settings, persistence, diagnostics, and watchdogs;
- `SidecarProcess.cs` combines process lifecycle with most host RPC implementations;
- `ChatToolWindowControl.xaml.cs` combines WebView lifecycle, runtime caching, transport, state restoration, and diagnostics;
- boundary payloads frequently use `unknown`, `Record<string, unknown>`, or `JToken`;
- the two repositories duplicate nearly all authored sidecar and WebView source;
- legacy, upstream, generated, and active source are not sufficiently distinct.

## Non-negotiable invariants

1. The two VSIX variants expose identical behavior, UI, settings, and fixes.
2. Version-specific code is confined to packaging or compatibility adapters.
3. The WebView never calls `@cline/sdk` or Visual Studio APIs directly.
4. Cline SDK types do not escape the Cline integration boundary.
5. Every process-boundary request has a version, request ID, method or type, and typed payload.
6. Workspace writes and command execution retain explicit approval policy.
7. Interfaces exist for external boundaries or real substitution, not every internal class.
8. Feature execution remains directly traceable; no reflection registration or global event bus for core commands.
9. Feature tests stay close to their feature; contract, integration, and packaging tests remain centralized.
10. Migration is incremental and keeps both VSIX variants usable.

## Target shape

```text
src/
├─ extension-host/
│  ├─ Bootstrap/
│  ├─ WebView/
│  ├─ Sidecar/
│  ├─ Rpc/
│  └─ Adapters/{Workspace,Editor,Terminal,Diff,Window,Environment}/
├─ agent-worker/
│  ├─ Runtime/
│  ├─ Features/
│  ├─ Integrations/ClineSdk/
│  ├─ Adapters/
│  └─ Bootstrap/
├─ webview/{app,features,shared,transport}/
└─ contracts/{agent,host,webview,schemas}/
packaging/{vs2022-17.0,vs2022-17.12}/
upstream/
tests/{contract,integration,packaging}/
docs/
```

Physical moves can happen later. Dependency ownership and feature boundaries matter more than early directory renaming.

## Runtime ownership

### Visual Studio host

The .NET host owns VSIX and tool-window lifecycle, WebView2, sidecar installation and lifecycle, Visual Studio adapters, transport relay, and host diagnostics. `SidecarProcess` becomes a small lifecycle coordinator. Host RPC methods move to focused adapters.

### Agent worker

The Node worker owns agent sessions, chat execution, approvals, conversation state, SDK event normalization, MCP, browser, worktrees, hooks, providers, checkpoints, persistence, and UI projections.

### Cline integration

```text
Features -> AgentEngine port -> ClineAgentAdapter -> @cline/sdk
```

SDK events are normalized to internal typed events: `AgentStarted`, `TextDelta`, `ReasoningDelta`, `ToolCallRequested`, `ApprovalRequested`, `ToolCallCompleted`, `AgentCompleted`, and `AgentFailed`.

### WebView

The WebView renders state, gathers input, retains ephemeral UI state, and sends typed user intent. It does not own orchestration, Visual Studio operations, persistence semantics, or SDK state.

## Vertical-slice convention

```text
Features/Chat/SendMessage/
├─ SendMessageCommand.ts
├─ SendMessageHandler.ts
├─ SendMessageResult.ts
├─ SendMessageEvents.ts
└─ SendMessage.test.ts
```

First-class feature areas are Chat, Approvals, TaskHistory, Checkpoints, Settings, Providers, MCP, Browser, Worktrees, Hooks, and ScheduledAgents. A feature handler may depend on ports but not concrete WebView, Visual Studio, persistence, or SDK implementations.

## State boundaries

- `AgentSessionState`: lifecycle, active run, cancellation, pending interaction;
- `ConversationState`: messages, partial output, reasoning, usage;
- `WorkspaceState`: roots, changes, terminal activity, worktrees;
- `UiProjectionState`: renderable data and subscriptions.

Persisted state is an explicit snapshot. UI projections are not the domain model.

## Contract strategy

```ts
type RpcEnvelope<T> = {
  version: 1
  requestId: string
  method: string
  payload: T
}
```

Contracts are grouped by boundary and operation. TypeScript and C# representations are generated from shared schemas or verified by contract tests. Free-form payloads are normalized immediately at adapter edges. RPC handlers are registered explicitly in the composition root.

## Common-source strategy

The final repository has one sidecar, one WebView, and one extension-host implementation. Thin packaging profiles define only target framework, VS SDK versions, assembly and VSIX identity, installation range, and exceptional compatibility adapter selection. A build matrix validates both artifacts from the same commit.

Repository consolidation is a prerequisite for architectural refactoring. Until one canonical source tree builds both variants, do not extract feature slices independently in the two repositories. Guardrail and packaging work needed to achieve consolidation is allowed.

## Source hygiene

- WebView bundles, sidecar dist, bin, obj, and VSIX files are generated outputs.
- Air-gap binary inputs belong in a clearly named vendor or release-input area.
- Upstream/generated Cline contracts are isolated and marked read-only.
- Obsolete C# agent and bridge implementations are removed or archived outside active source after replacement is proven.
- A root `AGENTS.md` summarizes enforceable rules for AI maintainers.

## Migration sequence

### Phase 0: baseline and guardrails

- keep this document identical in both current repositories;
- distinguish active, legacy, upstream, and generated code;
- establish a two-variant build and package validation matrix;
- capture behavior and contract baselines.

### Phase 1: single common source

- select one canonical repository while preserving both existing repositories as recoverable history;
- move sidecar, WebView, shared contracts, and active extension-host source into one common tree;
- introduce thin 17.0 and 17.12 packaging profiles;
- build and validate both VSIX variants from the same commit;
- stop making duplicated feature edits after the common build is proven.

### Phase 2: typed contracts

- introduce typed envelopes and operation-specific host/WebView contracts;
- add cross-runtime contract tests;
- normalize `unknown` and `JToken` at boundaries.

### Phase 3: explicit agent runtime

- define internal agent events and session state;
- wrap `@cline/sdk` behind `AgentEngine`;
- characterize existing streaming and approval behavior.

### Phase 4: first vertical slices

Extract Chat/SendMessage, Chat/StartTask, Chat/CancelTask, Approvals, and TaskHistory in that order.

### Phase 5: remaining worker features

Extract providers/settings, MCP, worktrees, browser, hooks, scheduled agents, checkpoints, transcript projection, and diagnostics.

### Phase 6: .NET host decomposition

Separate host RPC routing from sidecar lifecycle; create focused host adapters; separate WebView runtime resolution, cache, bridge, and diagnostics from the tool-window control.

### Phase 7: cleanup and enforcement

Remove proven-dead legacy code, isolate upstream/generated code, stop tracking generated outputs where policy permits, and enforce dependency rules in CI.

## Definition of done

The target is complete only when:

- both VSIX variants build and pass package validation from one common source;
- functional tests and contract fixtures are shared;
- version differences are limited to documented compatibility and packaging files;
- the legacy WebView backend no longer owns unrelated feature orchestration;
- SDK types remain inside the integration adapter;
- typed agent events and RPC contracts cover runtime boundaries;
- the WebView contains no SDK or Visual Studio control logic;
- host capabilities are focused adapters;
- architecture, contract, integration, and packaging checks pass;
- active source contains no ambiguous legacy runtime implementation.
