# Worktrees slice

- Inputs: list, defaults, include-file, create, switch, merge, recovery, and delete commands.
- Outputs: normalized worktree metadata, mutation results, conflict recovery instructions, and feature availability.
- Owned state: no durable state; Git and workspace operations are injected through the worktree operations port.
- Main boundaries: `WorktreeQueryHandler`, `WorktreeMutationHandler`, `WorktreePolicy`, and `WorktreeRpcHandler`.
- Tests: `worktreeQueryHandler.test.js`, `worktreeMutationHandler.test.js`, and worktree policy coverage in `applicationPolicies.test.js`.

All paths and branch names must be validated before invoking Git. Dirty-delete and conflict recovery behavior belongs to policy/handler code, not the decoder.
