# Browser slice

- Inputs: connection probes, discovery, settings, browser tool actions, screenshots, and WebView RPC commands.
- Outputs: connection status, phased browser results, transcript DTOs, and explicit unsupported-operation responses.
- Owned state: active browser sessions and action phases inside `BrowserHandler`.
- Main boundaries: `BrowserHandler`, `BrowserPolicy`, `BrowserRpcHandler`, and `BrowserToolEventFlow`.
- Tests: `browserHandler.test.js`, `browserDevToolsAdapter.test.js`, and browser policy cases in `applicationPolicies.test.js`.

Browser automation must remain behind `BrowserAutomationPort`. URLs and remote-debug endpoints must be normalized before transport use.
