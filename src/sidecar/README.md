# VsCline Sidecar

This folder contains the active agent worker for the Visual Studio port.

The VSIX packages the compiled runtime from `artifacts/Sidecar/cline-sidecar.js`. TypeScript sources remain under `src/sidecar`.

The source is organized for explicit feature ownership and fast automated maintenance. The layer directories under `src/sidecar/src` retain useful dependency boundaries, while vertical feature slices own product behavior. Run `npm test` to execute dependency, cycle, ownership, contract, and behavioral parity checks.

Current responsibilities:

- own the Node process entrypoint
- receive WebView messages from the C# WebView2 host
- own typed WebView RPC handling and UI projections
- run the agent through `AgentEnginePort` and the isolated Cline SDK adapter
- call Visual Studio capabilities through focused host ports

The obsolete C# agent and direct bridge are not runtime fallbacks. They are preserved as read-only history under `legacy/dotnet-agent` and are excluded from the extension project.
