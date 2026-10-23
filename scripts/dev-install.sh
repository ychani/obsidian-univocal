#!/usr/bin/env bash
# Build the plugin and install it into a TEST vault.
#
#   scripts/dev-install.sh <vaultPath>
#
# Optional env:
#   UNIVOCAL_CONNECT_DIR=/tmp/uco-x   → data.json "connectDir"
#   DEVELOPER=1                       → data.json "developer": true (enables obsidian://univocal-dev)
#
# Refuses any path containing "ObsidianSecondBrain" or "Mobile Documents":
# the owner's real (iCloud-synced) vault must never be touched.
set -euo pipefail

PLUGIN_ID="univocal-read-aloud"

usage() {
	echo "usage: $0 <vaultPath>" >&2
	exit 64
}

[ $# -eq 1 ] || usage
VAULT_ARG="$1"
[ -n "$VAULT_ARG" ] || usage

refuse_if_real_vault() {
	case "$1" in
	*ObsidianSecondBrain* | *"Mobile Documents"*)
		echo "refusing: '$1' looks like the real iCloud vault (ObsidianSecondBrain / Mobile Documents)." >&2
		echo "Use a throwaway test vault instead." >&2
		exit 1
		;;
	esac
}

# Check the path as given AND as resolved (symlinks, relative paths).
refuse_if_real_vault "$VAULT_ARG"
[ -d "$VAULT_ARG" ] || {
	echo "error: vault directory '$VAULT_ARG' does not exist" >&2
	exit 1
}
VAULT="$(cd "$VAULT_ARG" && pwd -P)"
refuse_if_real_vault "$VAULT"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$REPO"

echo "→ building"
pnpm build

for f in main.js manifest.json; do
	[ -f "$f" ] || {
		echo "error: $f missing after build" >&2
		exit 1
	}
done

DEST="$VAULT/.obsidian/plugins/$PLUGIN_ID"
mkdir -p "$DEST"
cp main.js manifest.json "$DEST/"
if [ -f styles.css ]; then
	cp styles.css "$DEST/"
else
	echo "note: no styles.css yet; skipped"
fi
echo "→ copied plugin files to $DEST"

# Enable the plugin: create or merge community-plugins.json.
COMMUNITY="$VAULT/.obsidian/community-plugins.json"
PLUGIN_ID="$PLUGIN_ID" COMMUNITY="$COMMUNITY" node -e '
const fs = require("fs");
const file = process.env.COMMUNITY;
let list = [];
try {
	const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
	if (Array.isArray(parsed)) list = parsed.filter((x) => typeof x === "string");
} catch (e) {
	if (e.code !== "ENOENT") console.warn(`warning: replacing unreadable ${file}: ${e.message}`);
}
if (!list.includes(process.env.PLUGIN_ID)) list.push(process.env.PLUGIN_ID);
fs.writeFileSync(file, JSON.stringify(list, null, 2) + "\n");
'
echo "→ enabled $PLUGIN_ID in $COMMUNITY"

# data.json: merge only the settings given via env; leave the rest alone.
if [ -n "${UNIVOCAL_CONNECT_DIR:-}" ] || [ "${DEVELOPER:-}" = "1" ]; then
	DATA="$DEST/data.json" CONNECT_DIR="${UNIVOCAL_CONNECT_DIR:-}" DEV="${DEVELOPER:-}" node -e '
const fs = require("fs");
const file = process.env.DATA;
let data = {};
try {
	const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
	if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed;
} catch {}
if (process.env.CONNECT_DIR) data.connectDir = process.env.CONNECT_DIR;
if (process.env.DEV === "1") data.developer = true;
fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
'
	echo "→ wrote $DEST/data.json"
fi

echo "done. Reload Obsidian (or toggle the plugin) in that vault."
