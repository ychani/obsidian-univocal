# Publishing a plugin release

1. Update version in package.json and manifest.json; add its minimum Obsidian version to versions.json.
2. Run `pnpm lint`, `pnpm test` and `pnpm build`. Set UNIVOCAL_MOCK_BIN to include protocol integration tests.
3. Commit and push main. The read-only CI job must pass.
4. Create and push a tag equal to the manifest version, without a `v` prefix.
5. GitHub Actions verifies the tag/version match, builds from the frozen lockfile, generates provenance attestations, and publishes main.js, manifest.json and styles.css. Do not attach extra files to directory releases or mark them as GitHub prereleases.
6. Verify the GitHub release and attestations. Refresh the Obsidian Community entry through its UI, respecting its cooldown, and inspect the new review before claiming findings are resolved.

The plugin supports macOS desktop and Obsidian 1.12.7 or later. A Connect-capable Univocal build is required. The source repo is https://github.com/ychani/obsidian-univocal and the listing is https://community.obsidian.md/plugins/univocal-read-aloud.
