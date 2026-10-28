# Univocal Read Aloud (Obsidian plugin)

Read notes aloud with [Univocal](https://univocalapp.com) and highlight each word as it's spoken, in reading view and in Live Preview or source mode.

> **Public beta · macOS desktop only.** Requires a Connect-capable build of the [Univocal app](https://univocalapp.com). The plugin is free; continued use of Univocal after its trial requires a paid Univocal licence. No plugin account is required.

The plugin is available in [Obsidian Community plugins](https://community.obsidian.md/plugins/univocal-read-aloud).

## Install

**Community plugins (recommended):**

1. Open the [Univocal Read Aloud listing](https://community.obsidian.md/plugins/univocal-read-aloud) and choose **Add to Obsidian**.
2. Install and enable **Univocal Read Aloud** in the vault you want to use.
3. Connect from Univocal’s **Settings → Connections → Obsidian → Set up**, or run the plugin’s **Read aloud** command and approve the request in Univocal.

**Manual installation:** download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/ychani/obsidian-univocal/releases/latest), copy them into `<your vault>/.obsidian/plugins/univocal-read-aloud/`, reload the Community plugins list, and enable the plugin.

## Usage

- **Connect without starting a reading:** in Univocal, open **Settings → Connections → Obsidian → Set up**. After installing and enabling the plugin in the vault you want to use, click **Connect**, then approve the request in Univocal.
- **Read aloud:** use the command palette (**Univocal Read Aloud: Read aloud**) or the ribbon icon. Reading starts at the selection, or at the first visible paragraph. The first time, Univocal asks whether to allow Obsidian. The command has no default hotkey; set your own under **Settings → Hotkeys**.
- **While reading, Univocal's floating pill is the control:** pause and resume, skip sentences, change speed or voice, and stop there. Univocal's ⌥⇧R also toggles pause/resume. Read aloud and the ribbon icon do nothing while a reading is under way, and the status bar just shows **Reading aloud…** or **Reading paused**.
- The spoken word and sentence are highlighted. Switching notes stops reading. Editing the note restarts reading at the sentence you were on (if you edit while paused, the restart happens when you resume in Univocal).
- The status bar also says when Univocal is missing (**Get Univocal**), not running (**Univocal off**, click to start it), waiting for your approval, or not allowed.

### Univocal's read hotkey

Univocal has its own global hotkey (⌥⇧R by default). With this plugin enabled, pressing it while Obsidian is in front reads the **focused note in Obsidian**, with highlighting, instead of reading the selection in Univocal's panel. Pressing it again toggles pause/resume.

- This works once you've allowed Obsidian in Univocal (reading aloud once is enough). After that the plugin connects quietly whenever Obsidian and Univocal are both running. It never launches Univocal or prompts you on its own.
- With two vaults open, the vault whose window has focus answers.
- To keep Univocal's own behaviour, turn off **Answer Univocal's read hotkey** in the plugin settings.

## Privacy

- Note text goes only to Univocal on this Mac, over a local Unix socket. Nothing is sent over the network by this plugin.
- Univocal's grant for Obsidian (a token) is stored in the **macOS Keychain**. If Keychain access fails, the plugin uses a file readable only by your user at `~/Library/Application Support/obsidian-univocal/tokens.json`. Neither location is inside the vault or synced with your notes. **Settings → Forget authorization** removes the stored token.
- The plugin reads Univocal's local connection-discovery files outside the vault to find its Unix socket. It uses the macOS `security` tool for Keychain access and Launch Services to locate or start Univocal when you ask it to read. It does not install or update the Univocal app.
- No telemetry or analytics are collected. The plugin makes no remote network requests; opening an installation/help link uses your browser.
- The plugin's `data.json` only holds preferences (rate, highlight style, hotkey routing, developer options).

## Settings

| Setting | |
|---|---|
| Speaking rate | Sent with each reading; also applies to the current one. |
| Highlight style | Background or underline. Use underline if your theme colours editor lines. |
| Answer Univocal's read hotkey | Off: Univocal reads in its own panel. |
| Authorization | Status, **Ask again**, **Forget authorization**. |
| Developer mode | Enables the `obsidian://univocal-dev` URL handler and the connect directory override. |

## Updating and removing

Use Obsidian’s **Settings → Community plugins → Check for updates** control. For a manual installation, replace the three plugin files with those from a newer GitHub release and reload Obsidian. Preferences remain in `data.json`. The plugin never installs or updates itself.

To disconnect, use **Revoke** beside Obsidian in Univocal. To remove the saved credential too, use the plugin’s **Forget authorization** before uninstalling it through Obsidian’s Community plugins settings.

## Development

```sh
pnpm install
pnpm dev        # watch build → main.js
pnpm build      # typecheck + production build
pnpm typecheck
pnpm test       # vitest
pnpm lint       # official Obsidian ESLint rules
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
obsidian://univocal-dev?cmd=pause        # pause / resume (dev-only, for QA)
obsidian://univocal-dev?cmd=stop         # dev-only, for QA
obsidian://univocal-dev?cmd=status[&tag=…]
```

`pause` and `stop` exist only for automated QA. The plugin has no user-facing pause or stop; users control a reading in Univocal's pill.

`status` writes `univocal-dev-status.json` into the connect dir. It holds the state, session id, last word and sentence ranges, painted-range counts (`painted.word` must never exceed the ranges of one word), the current mode (`reading` / `live-preview` / `source`), the note path and the connection state. It never contains note text. Example: `open -g "obsidian://univocal-dev?cmd=status&tag=1"`.

### Layout

- `src/connect/`: the Univocal Connect protocol client. It's self-contained, with no Obsidian imports.
- `src/textmap/`, `src/highlight/`: text extraction and offset mapping, and the word and sentence highlighters.
- `src/controller.ts`: the read-aloud state machine. It's Obsidian-free and tested with fakes in `test/controller/`.
- `src/main.ts`, `src/settings.ts`, `src/statusBar.ts`, `src/devProtocol.ts`: the plugin shell.

## Review and security

See [SECURITY.md](SECURITY.md) for native capability scope and the remaining generic CSS compatibility notices. See [CONTRIBUTING.md](CONTRIBUTING.md) for verification and release requirements.

## License

MIT © 2026 NarNar Labs
