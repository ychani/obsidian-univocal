# Publishing a plugin release

1. Update `version` in `manifest.json` and `package.json`, and add the minimum supported Obsidian version to `versions.json`.
2. Run `pnpm test` and `pnpm build`. Set `UNIVOCAL_MOCK_BIN` to the protocol mock to include all integration tests.
3. Create a Git tag matching the manifest version exactly (no `v` prefix).
4. Attach `main.js`, `manifest.json`, and `styles.css` to the GitHub release. Also attach a zip containing only these three files for manual installation.
5. Describe compatibility, installation, and known beta limitations in the release notes.
6. For the first Community directory listing, submit https://github.com/ychani/obsidian-univocal at https://community.obsidian.md after signing in and linking the maintainer's GitHub account. Do not advertise a marketplace link until the listing is published.

The public plugin is macOS desktop only. Its initial supported Obsidian version is 1.12.7; earlier versions have not been verified. A Connect-capable Univocal build is required.
