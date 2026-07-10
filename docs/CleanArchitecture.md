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

`VisualStudioWebviewRouter` depends on `ClineRuntimePort`, `HostProviderPort`, `WebviewTransportPort`, and `InteractionLoggerPort`. Concrete implementations are wired in `main.ts`.

Run `npm test` in `src/sidecar` to enforce the dependency direction. The architecture check rejects inward layers importing outward layers and rejects concrete infrastructure imports from the WebView router.

## Incremental Migration

The current router remains large, so migration continues by behavior rather than by arbitrary file size:

1. Extract task/session lifecycle use cases into `application/task`.
2. Extract MCP management into `application/mcp`.
3. Extract worktree and browser orchestration into dedicated application use cases.
4. Keep SDK, filesystem, network, process, and Visual Studio calls in infrastructure adapters.
5. Keep React components free of host implementations and access RPC through presentation gateways.

A move is complete only when tests pass and the architecture check proves the dependency direction.

## References

- Microsoft .NET architecture guidance: https://learn.microsoft.com/en-us/dotnet/architecture/modern-web-apps-azure/common-web-application-architectures
- Robert C. Martin, The Clean Architecture: https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html
