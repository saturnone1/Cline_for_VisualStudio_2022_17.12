# Clean Architecture

## Dependency Rule

Source dependencies point inward:

```text
domain <- application <- infrastructure
                    <- presentation

main.ts = composition root
```

The domain contains pure business rules. Application defines use-case contracts and ports. Infrastructure implements SDK, Visual Studio host, diagnostics, and transport details. Presentation translates WebView RPC into application calls. Only the composition root creates concrete implementations.

## Product Boundaries

LIG VS is a distributed desktop application with three runtime boundaries:

- `src/extension`: Visual Studio and WebView2 host adapter.
- `src/sidecar`: agent application runtime and the current Clean Architecture enforcement boundary.
- `src/webview`: presentation client that communicates through RPC contracts.

These runtimes should not share concrete implementations. Data crossing a process boundary must be a DTO or RPC message.

## Sidecar Layout

```text
src/sidecar/src/
├── domain/          # pure task and agent rules
├── application/     # use cases and ports
├── infrastructure/  # Cline SDK, VS host, diagnostics, JSON-RPC
├── presentation/    # WebView request routing
└── main.ts          # composition root
```

`VisualStudioWebviewController` parses raw WebView messages and invokes `WebviewApplicationPort`. `VisualStudioWebviewBackend` is a thin compatibility facade over `WebviewBackendComposition`; feature behavior lives in focused use cases, handlers, projectors, and adapters. Concrete implementations are wired only in the bootstrap composition root.

Current extracted use cases:

- `TaskLifecycleUseCase`: owns accepted task transitions and duplicate cancellation protection.
- `TaskSessionUseCase`: activates and hydrates SDK sessions.
- `McpUseCase`: owns MCP queries and mutations.
- `StatePersistenceUseCase`: owns debounced persistence and shutdown flush behavior.

Browser executable discovery, DevTools WebSocket communication, browser actions, and OpenGraph fetching live in `infrastructure/browser/BrowserDevToolsAdapter`. The legacy backend only coordinates browser RPC state with this adapter.

Additional feature boundaries extracted from the legacy backend:

- `ConversationSupport`: transcript, reasoning, attachment, and tool-message normalization.
- `ProviderConfiguration`, `ProviderIdentity`, and `ProviderAuthSupport`: provider settings, aliases, credentials, and OAuth support.
- `HookRuntime`, `ModelCatalog`, `WorktreeSupport`, and `LocalAutomationStore`: focused infrastructure behavior for their respective external systems.
- `WebviewState`: WebView adapter state creation, restoration, and persistence snapshots.

`SidecarRpcServer` owns named-pipe, JSON-RPC, and process shutdown behavior. `main.ts` is limited to object construction and dependency wiring.

Run `npm test` in `src/sidecar` to enforce the dependency direction. The architecture check rejects inward layers importing outward layers and rejects concrete infrastructure imports from the WebView router.

## Ongoing Guardrails

The migration is protected by executable constraints rather than file-placement convention alone:

1. Keep conversation, worktree, browser, provider, MCP, and task behavior in their owning slices.
2. Define every cross-runtime operation and payload shape in `contracts/webview-rpc.json`, then regenerate TypeScript and C# artifacts.
3. Retain broad compatibility payloads only at explicitly identified external boundaries and normalize them immediately.
4. Keep SDK, filesystem, network, process, and Visual Studio calls in infrastructure adapters.
5. Keep React components free of host implementations and access RPC through typed presentation gateways.
6. Require tests, AST dependency/cycle checks, contract audits, and both VSIX smoke gates for structural changes.

## References

- Microsoft .NET architecture guidance: https://learn.microsoft.com/en-us/dotnet/architecture/modern-web-apps-azure/common-web-application-architectures
- Robert C. Martin, The Clean Architecture: https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html
