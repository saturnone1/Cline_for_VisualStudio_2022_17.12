# Visual Studio host ownership map

The extension is a transport and lifecycle host. Agent behavior belongs in the sidecar.

- Inputs: Visual Studio commands, ToolWindow lifecycle events, WebView messages, and named-pipe sidecar responses.
- Outputs: Visual Studio adapter calls, WebView messages, sidecar process supervision, and diagnostics.
- Owned state: WebView runtime/cache state, pending host messages, sidecar process ownership, and ToolWindow lifetime.
- Feature owners: `ToolWindows` for view lifetime, `Host` for WebView/sidecar transport, `HostRpcAdapterFactory` for host adapter composition, `Host/Adapters` for Visual Studio RPC, and `Services` for editor and command execution.
- Tests: `tests/extension`, package validation, and dual-VSIX runtime smoke.

ToolWindow close and package shutdown must dispose owned resources exactly once. Keep version differences in `packaging/vs2022-*`; do not branch product behavior in this project.
