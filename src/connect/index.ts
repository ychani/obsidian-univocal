/**
 * @univocal/connect — Univocal Connect protocol client (SPEC v1), Node/Electron.
 *
 * SELF-CONTAINED: this directory must never import `obsidian` (or anything
 * outside `src/connect/`). It is meant to become a standalone package later.
 *
 * Contract (see the approved plan §1, §4 and SPEC §3–§16):
 * - Transport is the Unix domain socket named in `<connectDir>/connect.json`
 *   (`discovery.socket`), opened with `require("net").connect({ path })`.
 *   Never assume the well-known socket path, and NEVER use the renderer
 *   WebSocket (its Origin `app://obsidian.md` is refused by the server).
 * - Framing is NDJSON: one JSON object per `\n`-terminated line, 1 MiB line cap.
 * - Offsets everywhere are UTF-16 code units (plain JS string indices).
 * - The token store read never blocks the handshake: the client wraps it in a
 *   short timeout and connects without a token on failure.
 * - One client per plugin instance. Unknown message `type`s are ignored.
 *   Server `ping` → `pong`.
 * - Univocal is launched ONLY by `connect({ launch: true })`, via
 *   `open -g -b com.univocal.app --args --connect`.
 */

export * from "./types";
export { UnivocalClient, defaultIsInstalled, defaultLauncher } from "./client";
export { UnivocalError, isUnivocalError } from "./errors";
export { resolveConnectDir, defaultConnectDir, tokenAccount, readDiscovery, readLiveDiscovery, parseDiscovery, pidAlive, DEFAULT_APP_BUNDLE_ID } from "./discovery";
export {
	KeychainTokenStore,
	FileTokenStore,
	FallbackTokenStore,
	InMemoryTokenStore,
	TokenStoreTimeoutError,
	createDefaultTokenStore,
	defaultTokenFile,
	withTimeout,
	TOKEN_SERVICE,
	type ExecFileFn,
	type ExecFileCallback,
	type KeychainTokenStoreOptions,
	type DefaultTokenStoreOptions,
} from "./tokenStore";
export { chunkText, utf8Length, CHUNK_UTF8_BYTES } from "./chunking";
export { NdjsonDecoder, encodeFrame, DEFAULT_MAX_FRAME_BYTES, type WireMessage } from "./ndjson";
export { ReadingSessionImpl } from "./session";
