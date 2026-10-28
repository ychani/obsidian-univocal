# Contributing

Use project-local dependencies: `pnpm install --frozen-lockfile` (pnpm 11.20.0; CI uses Node 24).

Before a change is published, run `pnpm lint`, `pnpm test` and `pnpm build`. The official Obsidian lint configuration covers the shipping TypeScript source. TypeScript 6 is pinned because typescript-eslint currently does not support the TypeScript 7 API.

Set `UNIVOCAL_MOCK_BIN` to a built `univocal-mock` executable to include protocol integration tests. Without it the 12 integration cases are explicitly skipped. Tests must never use the real Keychain or a real vault. Use only a throwaway vault for manual UI checks.

Preserve Obsidian 1.12.7 compatibility. Settings on 1.13 and later use searchable definitions; 1.12 uses the imperative fallback. Change both paths when a setting changes. Preserve the owner document/window for rendering and use Node timers for the window-independent protocol/controller backend.

Do not suppress scanner findings to change the rating. Fix actionable findings and explain legitimate native capabilities in SECURITY.md. Do not log grant tokens or note text.

Publish through the GitHub Actions workflow: update package.json, manifest.json and versions.json, commit, then push a tag matching the manifest version exactly. CI verifies the source before the tag job builds and attests the three plugin files. See RELEASE.md.
