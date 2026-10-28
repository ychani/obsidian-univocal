# Security and review notes

## Native capabilities

This is a macOS desktop plugin. It runs with Obsidian’s normal Node/Electron privileges; these operational scopes are not an OS sandbox.

- **Filesystem:** read Univocal’s connection-discovery file under its Application Support folder; connect to the Unix socket it names; watch discovery for app start/quit; and manage the authorization token fallback file outside the vault. A different connection folder can be selected explicitly in developer settings. Developer status output is written only when developer mode is enabled. The plugin does not implement a general filesystem command interface.
- **Process execution:** call fixed macOS executables (`/usr/bin/security` for Keychain operations, `/usr/bin/open` to launch Univocal when requested, and `/usr/bin/mdfind` to locate it). Calls use `execFile` with argument arrays, not a shell. Read-aloud text is never passed to a process command line. The Keychain grant is passed to the native security tool for storage; that is sensitive and must not be logged.
- **Authorization:** Keychain is primary. The documented fallback is a user-readable-only token file outside the vault (0600; new parent folders 0700). It is never synced as vault data. Forget authorization deletes stored credentials; Revoke in Univocal removes the server grant.
- **Network:** note text stays on this Mac over a Unix domain socket. The plugin does not upload it or collect telemetry. Opening product/install links uses the browser.

Filesystem and process-execution warnings are legitimate capability disclosures. The implementation must remain auditable; they are not silenced or concealed to improve a score.

## CSS partial-support notices

The directory’s CSS scan groups the standard `text-decoration` properties into a partially supported browser feature. The Chromium partial-support note concerns `text-decoration-skip` values; this plugin does not set `text-decoration-skip`. See the [upstream compatibility notes](https://caniuse.com/text-decoration).

The optional underline style uses underline, dotted/solid styles, color and thickness, including the properties allowed on CSS highlight pseudo-elements. Background highlighting is the default. We retain these visible generic notices rather than remove underline functionality or disable compatibility checks. Verify underline rendering on supported desktop Obsidian/Electron versions when changing the CSS.

## Other review signals

Production TypeScript is checked with the official Obsidian ESLint rules. Builds are unminified and reproducible. Starting with 0.1.1, GitHub Actions generates provenance attestations for the three release assets; no extra ZIP is attached to the directory release.

An unavailable malware or network-request scan is not a passed scan. Dependency and source checks do not prove that a plugin is safe in every circumstance.

For a suspected vulnerability, open a GitHub security advisory rather than posting note text, tokens or account information in a public issue.
