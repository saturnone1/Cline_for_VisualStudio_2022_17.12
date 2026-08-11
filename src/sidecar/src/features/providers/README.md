# Providers slice

- Inputs: provider selection, credential mutations, OAuth callbacks, account actions, and model catalog queries.
- Outputs: normalized provider configuration, credential/auth status, model lists, and user-facing auth actions.
- Owned state: pending OAuth sessions and provider credential status; durable secrets are delegated to injected stores.
- Main boundaries: `ProviderCredentialHandler`, `OAuthAuthorizationHandler`, `OAuthCallbackHandler`, `ProviderAuthActionHandler`, and `ModelCatalogRpcHandler`.
- Tests: `provider*.test.js`, `oauth*.test.js`, and provider cases in `applicationPolicies.test.js`.

Never log credential or token values. SDK provider IDs and persisted product IDs must remain distinct at the adapter boundary.
