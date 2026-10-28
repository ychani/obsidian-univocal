# Changelog

## 0.1.1

- Correct window-independent Node timer ownership while preserving cleanup and reconnect behavior.
- Use each rendered document’s own window for DOM creation and render-watcher timers.
- Normalize unusual promise rejections into Errors and remove unsafe/redundant assertions.
- Add searchable settings on Obsidian 1.13+ while retaining the 1.12.7 fallback and live authorization updates.
- Replace deprecated slider/refresh usage, handle asynchronous settings errors, and use an absolute native launch executable.
- Add official TypeScript lint checks, repeatable CI and attested releases containing only the three supported plugin assets.
- Document the required native capabilities and the generic text-decoration compatibility notices without hiding them.

## 0.1.0

Initial public release: local read aloud, word/sentence highlighting, reading controls and authenticated Univocal Connect integration.
