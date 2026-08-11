# Runtime slice

- Inputs: normalized agent runtime events, lifecycle transitions, latency/activity signals, and session bindings.
- Outputs: semantic event dispatch, lifecycle state, monitoring observations, and scheduled partial updates.
- Owned state: task/session lifecycle, activity timers, and latency measurements.
- Main boundaries: `AgentRuntimeEventDispatcher`, `AgentEventDispatcher`, `TaskSessionCoordinator`, and `RuntimeMonitoringCoordinator`.
- Tests: `agentRuntimeEvent.test.js`, `taskLifecycle*.test.js`, and `startCancelTask.test.js`.

Runtime code consumes domain events only; SDK event-shape compatibility belongs in the SDK adapter translator.
