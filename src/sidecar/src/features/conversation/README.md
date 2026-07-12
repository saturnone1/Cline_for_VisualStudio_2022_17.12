# Conversation slice

- Inputs: normalized agent events, SDK messages, and tool activity.
- Outputs: stable UI transcript projection and active partial/reasoning/tool state.
- Owned state: transient projection markers in `ConversationProjectionState`.
- Infrastructure collaborators: the focused projectors under `infrastructure/conversation`.
- Tests: `conversationNormalization.test.js`, `agentRuntimeEvent.test.js`, and WebView backend tests.

Raw SDK envelopes must be normalized before entering this slice. Keep transcript formatting deterministic and bounded.
