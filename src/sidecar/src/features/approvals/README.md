# Approvals slice

- Inputs: normalized tool approval requests and user decisions.
- Outputs: allow/deny results, lifecycle transitions, prompts, and audit events.
- Owned state: one pending approval in `ApprovalCoordinator`.
- Main boundaries: `ApprovalCoordinator` and `ToolApprovalFlow`.
- Tests: `approvalCoordinator.test.js` and approval cases in `agentRuntimeEvent.test.js`.

Superseding, cancellation, and disposal must always resolve the pending request exactly once.
