# History UI ownership

- Inputs: task history state and Task RPC query results.
- Outputs: filter, selection, favorite, delete, export, and navigation intents.
- Owned state: visible filters, search text, sort selection, and local confirmation UI.
- Main boundaries: `useHistoryViewController` owns RPC concurrency and mutations; `HistoryView` renders its typed view state; item components own row interaction only.
- Tests: history behavior tests and Task RPC contract fixtures.

The sidecar owns persisted filtering semantics and storage size. Keep RPC calls out of `HistoryView`; layout-only grouping and highlighting may remain in the rendering component.
