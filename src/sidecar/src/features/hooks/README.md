# Hooks slice

- Inputs: hook discovery, create/delete/toggle, lifecycle execution, and pre-tool decisions.
- Outputs: hook projections, execution observations, transcript messages, and allow/deny decisions.
- Owned state: hook enablement is delegated to `HookStorePort`; execution is delegated to `HookExecutionPort`.
- Main boundaries: `HookSettingsHandler`, `HookExecutionHandler`, `HookLifecycleCoordinator`, `HookPolicy`, and `HookRpcHandler`.
- Tests: `hookSettingsHandler.test.js` and hook policy cases in `applicationPolicies.test.js`.

Hook output is untrusted. Normalize the final structured response and never let arbitrary output bypass approval policy.
