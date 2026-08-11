# Rules and skills UI ownership

- Inputs: instruction settings RPC state and workspace/global rule descriptors.
- Outputs: typed create, delete, toggle, and refresh intents.
- Owned state: modal tabs, local selection, and transient edit controls.
- Main boundaries: `ClineRulesToggleModal` and focused rule/skill list components.
- Tests: instruction settings contract tests and relevant settings component tests.

Filesystem discovery and persistence belong in the sidecar settings slice. Keep this directory presentation-only.
