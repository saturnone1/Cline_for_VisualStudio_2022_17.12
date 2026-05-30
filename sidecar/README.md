# VsCline Sidecar

This folder is the migration target for the Visual Studio port.

The VSIX currently packages `VsClineAgent/Sidecar/cline-sidecar.js`. The next step is to move that runtime into TypeScript here, then bundle upstream Cline's TypeScript core into the packaged sidecar.

Current responsibilities:

- own the Node process entrypoint
- receive WebView messages from the C# WebView2 host
- take ownership of safe gRPC service methods before the C# bridge fallback
- eventually host upstream Cline core and a `VisualStudioHostProvider`

The C# `VisualStudioClineBridge` remains a fallback during migration only.

