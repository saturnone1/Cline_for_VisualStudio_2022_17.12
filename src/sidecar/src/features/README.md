# Feature slices

Each directory is a vertical slice owned by the product layer. A slice may depend on domain types and application ports, but it must not import Visual Studio transport, WebView wire envelopes, or `@cline/sdk` directly.

When changing a slice:

1. Start from its README and public command/result types.
2. Keep decoding in `infrastructure/webview/*RpcDecoder.ts`.
3. Keep SDK, filesystem, HTTP, and Visual Studio calls behind injected ports or callbacks.
4. Add a focused test under `src/sidecar/tests` and retain the architecture/parity gates.
5. Update the slice README when ownership or its public contract changes.

Cross-slice orchestration belongs in an application use case or an explicit coordinator. It must not be hidden in a decoder or UI component.
