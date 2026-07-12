# Task history slice

- Inputs: SDK session lists/messages, show/delete/favorite commands, and task snapshots.
- Outputs: ordered history, selected transcript hydration, snapshots, and persistence requests.
- Owned state: deleted IDs, in-memory snapshots, selected task, and synchronized history projection.
- Main boundaries: `TaskHistorySync`, `TaskHistoryCommands`, `TaskTranscriptHydrator`, and `TaskStateCoordinator`.
- Tests: `taskHistoryCollection.test.js`, `taskSessionUseCase.test.js`, and conversation normalization tests.

History identity rebinding must update history, snapshots, and latency/session references together.
