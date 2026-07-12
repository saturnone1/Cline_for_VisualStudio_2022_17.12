# Settings slice

- Inputs: product settings mutations, Plan/Act changes, rules/workflows/skills toggles, and diagnostics requests.
- Outputs: persisted state changes, SDK setting operations, state refresh decisions, and diagnostic payloads.
- Owned state: none directly; product state and SDK settings are accessed through callbacks and `AgentEnginePort`.
- Main boundaries: `SettingsRpcHandler`, `InstructionSettingsRpcHandler`, `SdkSettingsHandler`, and `PlanActMode`.
- Tests: settings cases in `applicationPolicies.test.js`, `providerSettings.test.js`, and WebView backend tests.

Keep product state names separate from SDK setting types. A new setting requires normalization, persistence ownership, and a deterministic default.
