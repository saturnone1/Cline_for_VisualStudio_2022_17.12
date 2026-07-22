# WebView ownership map

The WebView is a passive renderer and typed-intent source. Persisted state and task orchestration remain in the sidecar.

- Inputs: generated RPC clients, extension state streams, and local user interactions.
- Outputs: typed RPC requests and ephemeral navigation or input state.
- Owned state: navigation, model catalogs, task stream projection, draft input, and other view-only state under `src/context`.
- Feature owners: chat in `components/chat`, history in `components/history`, settings in `components/settings`, MCP in `components/mcp`, and worktrees in `components/worktrees`.
- Tests: colocated `*.spec.*` and `*.test.*` files, executed by `npm test`.

Keep `ChatView` mounted while secondary views are open so draft and streaming state survive navigation. Secondary views may be lazy-loaded. New RPC payloads must originate in `contracts/webview-rpc.json`, never in handwritten generated files.
