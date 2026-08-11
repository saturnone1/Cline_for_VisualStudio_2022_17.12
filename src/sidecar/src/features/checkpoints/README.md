# Checkpoints slice

- Inputs: restore, compare/diff, and checkpoint metadata commands.
- Outputs: validated restore scope, diff metadata, transcript annotations, and RPC results.
- Owned state: none; checkpoint storage and workspace changes are injected.
- Main boundaries: `CheckpointPolicy`, `CheckpointHandler`, and `CheckpointRpcHandler`.
- Tests: `checkpointPolicy.test.js` and checkpoint paths in WebView backend tests.

Restore scope and run counts must be normalized before any workspace mutation.
