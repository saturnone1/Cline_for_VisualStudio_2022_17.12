# Files slice

- Inputs: open, copy, search, rules/hooks/skills refresh, and revert commands.
- Outputs: host file operations, normalized search/configuration payloads, and state-refresh decisions.
- Owned state: none; filesystem and Visual Studio host access are injected.
- Main boundary: `FileRpcHandler`; wire decoding stays in `FileRpcDecoder`.
- Tests: file behavior is covered by WebView backend/router tests and host adapter tests.

Resolve paths against the workspace and keep host-specific operations outside the feature handler.
