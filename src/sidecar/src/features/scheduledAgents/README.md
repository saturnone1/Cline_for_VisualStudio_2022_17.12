# Scheduled agents slice

- Inputs: list, save, delete, toggle, run-now, and run-history commands.
- Outputs: normalized schedules, local run records, launch requests, and disabled-state explanations.
- Owned state: schedule specifications and bounded run history through `ScheduledAgentStorePort`.
- Main boundaries: `ScheduledAgentHandler`, `ScheduledAgentPolicy`, and `ScheduledAgentRpcHandler`.
- Tests: `scheduledAgentHandler.test.js` and `scheduledAgentPolicy.test.js`.

Scheduled agents are local-only unless the capability registry and runtime configuration explicitly say otherwise. Validate workspace and prompt before launching.
