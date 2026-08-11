# MCP slice

- Inputs: list, add, toggle, timeout, restart, delete, authenticate, tool-approval, and marketplace commands.
- Outputs: normalized MCP server payloads, mutation errors, and stream-publication decisions.
- Owned state: none; SDK MCP manager and settings persistence live behind `McpRuntimePort`.
- Main boundaries: `McpHandler` for application operations and `McpRpcHandler` for product RPC behavior.
- Tests: `mcpUseCase.test.js`, `mcpProjection.test.js`, and MCP router cases.

Capability limitations such as marketplace installation must be reflected in `CapabilityRegistry` and returned explicitly, never silently ignored.
