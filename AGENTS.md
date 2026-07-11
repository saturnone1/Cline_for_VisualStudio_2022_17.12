# Canonical repository rules

- This repository is the only feature-development source for both Visual Studio 2022 variants.
- Shared behavior belongs under `src/`; never copy feature logic by Visual Studio version.
- Keep `packaging/vs2022-17.0` and `packaging/vs2022-17.12` limited to SDK, framework, manifest, assembly, and compatibility metadata.
- Build and validate both VSIX variants from the same commit before publishing a feature change.
- Document a real host compatibility difference before adding a version-specific adapter.
- Preserve the former 17.0 repository as historical evidence; do not resume parallel feature development there.
- Repository consolidation and dual-package reproducibility are prerequisites for the architecture migration in `docs/TargetArchitecture.md`.
