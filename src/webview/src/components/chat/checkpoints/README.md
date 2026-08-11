# Checkpoint UI ownership

- Inputs: SDK-backed `checkpoint_created` messages and checkpoint availability state.
- Outputs: typed compare and restore RPC intents.
- Owned state: only menu visibility and per-action pending guards.
- Runtime authority: checkpoint creation and restore semantics remain in the sidecar `features/checkpoints` slice.

Do not synthesize checkpoints from user-message timestamps. A restore control is rendered only for checkpoint metadata emitted by the SDK and projected by the sidecar.
