#!/usr/bin/env bash
# Start univocal-mock for manual QA of the plugin (never touches the real Univocal folder).
#
#   scripts/mock.sh [serve flags…]        e.g. scripts/mock.sh --consent prompt --wpm 240
#
# Binary: $UNIVOCAL_MOCK_BIN. Connect dir: $UNIVOCAL_MOCK_DIR, else a fresh short dir
# under /tmp/claude-501 (sun_path is limited to 103 bytes). Point the plugin's
# "Connect directory" setting at the printed dir (or launch Obsidian with
# UNIVOCAL_CONNECT_DIR set). In another terminal, drive it with:
#
#   "$UNIVOCAL_MOCK_BIN" ctl --dir <dir> frontmost <obsidian-renderer-pid>
#   "$UNIVOCAL_MOCK_BIN" ctl --dir <dir> hotkey document
#   "$UNIVOCAL_MOCK_BIN" ctl --dir <dir> preempt | status | revoke all
#
# Default flags: --consent allow --verbose (later flags override). Ctrl-C quits and cleans up.
set -euo pipefail

BIN="${UNIVOCAL_MOCK_BIN:-}"
if [[ -z "$BIN" || ! -x "$BIN" ]]; then
	echo "error: set UNIVOCAL_MOCK_BIN to the univocal-mock binary" >&2
	echo "  (swift build -c release --product univocal-mock in the PreviewMD repo)" >&2
	exit 1
fi

if [[ -n "${UNIVOCAL_MOCK_DIR:-}" ]]; then
	DIR="$UNIVOCAL_MOCK_DIR"
	mkdir -p "$DIR"
	chmod 700 "$DIR"
	CREATED=0
else
	mkdir -p /tmp/claude-501
	DIR="$(mktemp -d /tmp/claude-501/uco-XXXX)"
	CREATED=1
fi

cleanup() { if [[ "$CREATED" == 1 ]]; then rm -rf "$DIR"; fi; }
trap cleanup EXIT

echo "connect dir: $DIR"
echo "  export UNIVOCAL_CONNECT_DIR=$DIR"
"$BIN" serve --dir "$DIR" --consent allow --verbose "$@"
