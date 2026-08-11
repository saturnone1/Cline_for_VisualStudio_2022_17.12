# Chat slice

- Inputs: typed new-task, response, cancellation, feedback, and history commands decoded from Task RPC.
- Outputs: agent-engine commands, task lifecycle transitions, transcript projections, and RPC payloads.
- Owned state: no durable state; flows coordinate task/session state through injected callbacks.
- Main boundaries: `TaskPromptFlow`, `TaskRpcHandler`, and the `startTask`, `sendMessage`, `cancelTask`, `clearTask`, and `runtime` sub-slices.
- Tests: `sendMessage.test.js`, `startCancelTask.test.js`, `taskLifecycle*.test.js`, and `webviewBackend.test.js`.

Do not import `@cline/sdk` or WebView envelopes here. New chat commands require a decoder case, typed command, handler branch, and test.
