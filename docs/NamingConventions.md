# Naming Conventions

## Source Files

- C# type and XAML code-behind files use `PascalCase` and match the primary type or control name.
- React component files use `PascalCase`, for example `HoverCard.tsx`.
- TypeScript modules, utilities, hooks, services, scripts, CSS modules, and JSON configuration files use `camelCase`.
- Test files keep the target file name and append `.test` or `.spec`, for example `contextMentions.test.ts`.
- Storybook files keep the component name and append `.stories`, for example `HoverCard.stories.tsx`.

## Directories And Other Files

- C# project directories use `PascalCase`.
- TypeScript and React domain directories use `camelCase`.
- Repository role directories use short lowercase names such as `assets`, `artifacts`, `docs`, `scripts`, and `vendor`.
- Descriptive Markdown documents use `PascalCase.md`; standard entry files such as `README.md` keep their ecosystem names.
- PowerShell scripts use the `Verb-Noun.ps1` convention.
- Third-party installers and runtimes live under `vendor/`, outside source and automation directories.

## Exceptions

- Ecosystem-defined files keep their standard names, including `package-lock.json` and `vite-env.d.ts`.
- Declaration shims may keep descriptive kebab names when required by tooling, such as `global-stubs.d.ts`.
- Brand assets keep their published asset names, such as `lig-mark-white.png`.
- Test directories keep the runner convention `__tests__`.
- Generated files under `artifacts/`, `bin/`, `obj/`, and `dist/` are not renamed manually.

When renaming a module, update every import, test reference, build script, and package script in the same change.
