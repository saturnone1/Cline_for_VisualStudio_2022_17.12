# Plugins slice

- Inputs: local plugin discovery and refresh commands.
- Outputs: normalized local plugin descriptors and configuration status.
- Owned state: none; discovery is injected into `PluginRpcHandler`.
- Tests: plugin routing is covered by unary router and parity tests.

This slice does not install or execute plugins. Capability changes must be registered before broadening that scope.
