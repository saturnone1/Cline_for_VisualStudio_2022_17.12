# Terminal slice

- Inputs: terminal list/output/continue/cancel commands and normalized identifiers.
- Outputs: Visual Studio host terminal operations and state-refresh decisions.
- Owned state: no durable state; terminal monitoring lives in the infrastructure adapter.
- Main boundary: `TerminalRpcHandler` with host operations injected through ports.
- Tests: terminal policy coverage in `applicationPolicies.test.js` and host adapter tests.

Commands and paths must use platform normalization before reaching the Visual Studio host.
