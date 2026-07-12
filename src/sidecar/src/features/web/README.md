# Web and streams slice

- Inputs: state/auth/partial/MCP subscriptions, URL/open-graph commands, and stream cancellation.
- Outputs: subscription results, state refresh scheduling, and safe WebView payloads.
- Owned state: MCP subscription IDs in `StreamingRpcHandler`; scheduled refresh timer in `StateStreamRefreshCoordinator`.
- Main boundaries: `StreamingRpcHandler`, `StateStreamRefreshCoordinator`, and `UiWebRpcHandler`.
- Tests: `webviewStreamingRpcRouter.test.js`, `webviewController.test.js`, and WebView backend tests.

Direct HTTP belongs in an injected host/adapter, never in the passive WebView client.
