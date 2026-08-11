# Legacy .NET Agent

This directory preserves the pre-sidecar C# agent and WebView bridge implementation for repository history only.

- It is not compiled by `src/extension/VsClineAgent.csproj`.
- It is not an alternative runtime or compatibility profile.
- Active agent behavior belongs to the common Node sidecar behind `AgentEnginePort` and the `infrastructure/sdk` adapter.
- Fixes and features must not be implemented here.
- Delete this archive only after its historical value is no longer required.

The files were moved out of `src/extension` so AI maintainers and source searches cannot mistake the obsolete direct LLM/tool runtime for active product code.
