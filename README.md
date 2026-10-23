# Univocal Read Aloud (Obsidian plugin)

Read notes aloud with [Univocal](https://univocalapp.com) and highlight each word as it's spoken, in reading view and in Live Preview or source mode.

> Desktop only (macOS). Requires the Univocal app.

## Install

**Manual (now):**

1. Download `main.js`, `manifest.json` and `styles.css` from the latest [GitHub release](../../releases).
2. Copy them into `<your vault>/.obsidian/plugins/univocal-read-aloud/`.
3. In Obsidian, open **Settings → Community plugins**, reload the list and enable **Univocal Read Aloud**.

**Community plugin store (later):** once the plugin is listed, search for "Univocal Read Aloud" in **Settings → Community plugins → Browse**.

## Usage

- **Read aloud:** use the command palette (**Univocal Read Aloud: Read aloud**) or the ribbon icon. Reading starts at the selection, or at the first visible paragraph. The first time, Univocal asks whether to allow Obsidian.
- **Pause/resume** and **Stop** are commands too, and the status bar shows ⏸ / ⏵ / ■ while reading. None of the commands has a default hotkey; set your own under **Settings → Hotkeys**.
- The spoken word and sentence are highlighted. Switching notes stops reading. Editing the note restarts reading at the sentence you were on.
- The status bar also says when Univocal is missing (**Get Univocal**), not running (**Univocal off**, click to start it), waiting for your approval, or not allowed.

### Univocal's read hotkey

Univocal has its own global hotkey (⌥⇧R by default). With this plugin enabled, pressing it while Obsidian is in front reads the **focused note in Obsidian**, with highlighting, instead of reading the selection in Univocal's panel. Pressing it again pauses or resumes.

- This works once you've allowed Obsidian in Univocal (reading aloud once is enough). After that the plugin connects quietly whenever Obsidian and Univocal are both running. It never launches Univocal or prompts you on its own.
- With two vaults open, the vault whose window has focus answers.
- To keep Univocal's own behaviour, turn off **Answer Univocal's read hotkey** in the plugin settings.

## Privacy

- Note text goes only to Univocal on this Mac, over a local Unix socket. Nothing is sent over the network by this plugin.
- Univocal's grant for Obsidian (a token) is stored in the **macOS Keychain**, never in the vault, so it isn't synced. **Settings → Forget authorization** deletes it.
- The plugin's `data.json` only holds preferences (rate, highlight style, hotkey routing, developer options).

## Settings

| Setting | |
|---|---|
| Speaking rate | Sent with each reading; also applies to the current one. |
| Highlight style | Background or underline. Use underline if your theme colours editor lines. |
| Answer Univocal's read hotkey | Off: Univocal reads in its own panel. |
| Authorization | Status, **Ask again**, **Forget authorization**. |
| Developer mode | Enables the `obsidian://univocal-dev` URL handler and the connect directory override. |

## Development

```sh
pnpm install
pnpm dev        # watch build → main.js
pnpm build      # typecheck + production build
pnpm typecheck
pnpm test       # vitest
```

### Testing in a throwaway vault

```sh
UNIVOCAL_CONNECT_DIR=/tmp/uco-dev DEVELOPER=1 scripts/dev-install.sh ~/tmp/TestVault
```

`dev-install.sh` builds, copies `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/univocal-read-aloud/`, adds the id to `community-plugins.json`, and writes `connectDir` / `developer` into the plugin's `data.json` from the optional env. It refuses any path containing `ObsidianSecondBrain` or `Mobile Documents`, so it can never touch a real iCloud vault.

To test against the mock server, point Univocal's connect dir at a **short** path, because Unix socket paths are limited to 103 bytes:

```sh
univocal-mock serve --dir /tmp/uco-dev --consent allow
```

### Developer URL handler

With **Developer mode** on:

```
obsidian://univocal-dev?cmd=read[&prefer=selection|document]
obsidian://univocal-dev?cmd=pause        # pause / resume
obsidian://univocal-dev?cmd=stop
obsidian://univocal-dev?cmd=status[&tag=…]
```

`status` writes `univocal-dev-status.json` into the connect dir. It holds the state, session id, last word and sentence ranges, painted-range counts (`painted.word` must never exceed the ranges of one word), the current mode (`reading` / `live-preview` / `source`), the note path and the connection state. It never contains note text. Example: `open -g "obsidian://univocal-dev?cmd=status&tag=1"`.

### Layout

- `src/connect/`: the Univocal Connect protocol client. It's self-contained, with no Obsidian imports.
- `src/textmap/`, `src/highlight/`: text extraction and offset mapping, and the word and sentence highlighters.
- `src/controller.ts`: the read-aloud state machine. It's Obsidian-free and tested with fakes in `test/controller/`.
- `src/main.ts`, `src/settings.ts`, `src/statusBar.ts`, `src/devProtocol.ts`: the plugin shell.

## License

MIT © 2026 NarNar Labs
