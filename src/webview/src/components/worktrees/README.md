# Worktrees UI ownership

- Inputs: worktree query results and repository state.
- Outputs: typed create, switch, merge, lock, and delete intents.
- Owned state: selected worktree, modal state, and local loading/error presentation.
- Main boundaries: `WorktreesView` and focused modal components.
- Tests: WebView worktree tests and sidecar worktree feature tests.

Git execution and dirty-worktree policy belong in the sidecar worktrees slice, not this view.
