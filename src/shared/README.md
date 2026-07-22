# Shared compatibility source

- Inputs: upstream Cline-compatible message, provider, model, storage, and proto shapes.
- Outputs: runtime-neutral types and conversion helpers consumed by the sidecar and WebView.
- Owned state: none. Durable state belongs to the sidecar; UI state belongs to the WebView.
- Feature owners: product behavior stays in `src/sidecar/src/features` or `src/webview/src/components`, not here.
- Tests: colocated `*.test.ts` files and `__tests__` directories.

`api.ts` is the upstream-compatible provider/model catalog snapshot. It is intentionally kept as a compatibility surface because upstream imports expect `@shared/api`. Do not add Visual Studio behavior to it. Provider-specific runtime selection and configuration behavior belongs to the sidecar provider/configuration features. When the upstream catalog is refreshed, preserve the public exports and run both sidecar and WebView type checks.

Files under `proto/` are compatibility DTOs. Generated runtime contracts live under the explicit `generated/` directories and must be changed through their manifests and generators.
