# Repository Consolidation

## Decision

This repository is the canonical source for both LIG VS variants. The former
17.0 repository remains recoverable history and a migration baseline, but it is
not a second feature-development source after this consolidation is merged.

All shared behavior is implemented once under `src/`:

- `src/extension`: common Visual Studio host code;
- `src/sidecar`: common agent worker and Cline SDK adapter;
- `src/shared`: common upstream/shared contracts;
- `src/webview`: common UI.

Version differences live under `packaging/`:

| Profile | Framework | VS SDK | VSSDK BuildTools | Output |
| --- | --- | --- | --- | --- |
| `17.0` | .NET Framework 4.8 | 17.0.32112.339 | 17.0.5241 | `VsClineAgent17.vsix` |
| `17.12` | .NET Framework 4.7.2 | 17.6.36389 | 17.6.2164 | `VsClineAgent.vsix` |

Each profile owns only MSBuild properties, VSIX manifest metadata, and the
host-version value. Feature logic must not be copied into a profile.

## Build both variants

```powershell
.\scripts\Build-VsixVariants.ps1 -Configuration Release
```

The build installs locked frontend dependencies with `npm ci` when necessary,
prepares the pinned Node.js 22.23.1 Windows x64 runtime when it is missing, and
verifies the official archive SHA-256. For an offline build, prepare the npm
cache, place the Node archive on disk, and pass it explicitly:

```powershell
.\scripts\Build-VsixVariants.ps1 -Configuration Release `
  -NodeRuntimeArchive "D:\offline\node-v22.23.1-win-x64.zip"
```

For an already-built sidecar and WebView:

```powershell
.\scripts\Build-VsixVariants.ps1 -Configuration Release -SkipFrontend
```

Outputs:

```text
src/extension/bin/17.0/Release/VsClineAgent17.vsix
src/extension/bin/17.12/Release/VsClineAgent.vsix
```

The build script restores and compiles the same project twice with different
`VsTarget` profiles, then validates required payloads and assembly names.

## Dependency restore

`vendor/LocalPackages` is an expanded package cache, not a NuGet feed. Normal
online builds restore from nuget.org. Air-gap builds prepare the expanded cache
in advance and pass it as `RestorePackagesPath`; they must not treat it as a
package source unless it is converted into a proper folder feed containing
the required `.nupkg` files.

## Migration invariants

1. A feature change is made only in this canonical source tree.
2. Both VSIX variants are built and validated before publishing the change.
3. Profile files contain no user-visible feature behavior.
4. A compatibility difference must be documented before adding an adapter.
5. The former 17.0 repository is not deleted or force-rewritten; it is frozen
   after the canonical branch is accepted.

## Evidence required before freezing the former repository

- sidecar type-check and tests pass from the canonical checkout;
- WebView tests and production build pass;
- both VSIX packages pass `Test-VsixPackage.ps1`;
- package manifests contain the expected identity and installation range;
- smoke installation is performed in representative 17.0 and 17.12 Visual
  Studio instances when those environments are available.
