# Chat UI ownership

- Inputs: task stream state, normalized Cline messages, draft attachments, and user intent.
- Outputs: typed task RPC calls and ephemeral draft/navigation updates.
- Owned state: draft text, attachment selection, mention menus, scroll position, and local pending-click guards.
- Main boundaries: `ChatView`, `ChatTextArea`, `chatViewCore`, and the message renderer registry.
- Tests: chat `*.spec.*` and `*.test.*` files plus `context/TaskStreamState.spec.tsx`.

Keep `ChatView` mounted while secondary screens are visible. Message-kind behavior belongs in a renderer or `chatViewCore`; do not add another switch to the top-level view.
