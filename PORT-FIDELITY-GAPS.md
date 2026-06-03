# Port Fidelity Gaps

This file used to track an older C# bridge/runtime audit. That content is no longer the active source of truth because the project now routes runtime behavior through the Cline SDK sidecar.

Use [VS2022-SDK-COVERAGE.md](VS2022-SDK-COVERAGE.md) for the current feature matrix, Visual Studio parity gaps, and implementation order.

## Current Canonical Backlog

The remaining parity work is tracked in the "Visual Studio Parity Backlog" and "Remaining Work" sections of `VS2022-SDK-COVERAGE.md`.

High-level order and current progress:

1. Terminal/command execution Cline parity: 75%.
2. MCP server connection lifecycle: 70%. Online marketplace work is deferred
   for air-gapped deployments.
3. Browser tools and web fetch session support: 35%.
4. OAuth, account, and provider auth: 20%.
5. Checkpoint, diff, review, undo/revert completion: 65%.
6. Worktree create/switch/merge/delete: 20%.
7. Hooks, scheduled agents, plugins, and subagents: 15%.
8. Provider/model catalog parity: 35%.
