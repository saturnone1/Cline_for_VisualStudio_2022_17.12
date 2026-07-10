# VsCline Sidecar

This folder is the migration target for the Visual Studio port.

The VSIX packages the compiled runtime from `artifacts/Sidecar/cline-sidecar.js`. TypeScript sources remain under `src/sidecar`.

The source follows Clean Architecture layers under `src/sidecar/src`. Run `npm test` to execute both dependency-rule checks and behavioral parity checks.

Current responsibilities:

- own the Node process entrypoint
- receive WebView messages from the C# WebView2 host
- take ownership of safe gRPC service methods before the C# bridge fallback
- eventually host upstream Cline core and a `VisualStudioHostProvider`

The C# `VisualStudioClineBridge` remains a fallback during migration only.
