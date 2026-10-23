/**
 * Connect dir resolution and the discovery file (SPEC §3.1, §4.2).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Discovery } from "./types";

export const DEFAULT_APP_BUNDLE_ID = "com.univocal.app";
export const DISCOVERY_FILE = "connect.json";
export const PROTOCOL_NAME = "univocal-connect";
export const PROTOCOL_VERSIONS = [1];

/**
 * Resolve the connect dir: override, then `UNIVOCAL_CONNECT_DIR`, then
 * `~/Library/Application Support/Univocal/Connect` (`Univocal Dev` for a
 * `.dev` app bundle id).
 */
export function resolveConnectDir(override?: string, appBundleId: string = DEFAULT_APP_BUNDLE_ID): string {
	if (override) return expandHome(override);
	const env = process.env.UNIVOCAL_CONNECT_DIR;
	if (env) return expandHome(env);
	return defaultConnectDir(appBundleId);
}

/** The server's own `<ConnectDir>`, ignoring overrides and the environment. */
export function defaultConnectDir(serverBundleId: string = DEFAULT_APP_BUNDLE_ID): string {
	const folder = serverBundleId.endsWith(".dev") ? "Univocal Dev" : "Univocal";
	return path.join(os.homedir(), "Library", "Application Support", folder, "Connect");
}

/**
 * Token-store account for a server: its bundle id, plus `@<connectDir>` when
 * the dir is not that server's default — so a mock or test server never
 * shares (or deletes) the real Univocal's token. Mirrors the Swift client's
 * `UnivocalConfiguration.tokenAccount`.
 */
export function tokenAccount(serverBundleId: string, connectDir: string): string {
	const dir = path.resolve(connectDir);
	return dir === path.resolve(defaultConnectDir(serverBundleId)) ? serverBundleId : `${serverBundleId}@${dir}`;
}

function expandHome(p: string): string {
	return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

/** `kill(pid, 0)` liveness: alive unless the call fails with `ESRCH`. */
export function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Parse `connect.json`; `null` if absent, unreadable or not `univocal-connect`. Does not check the pid. */
export function readDiscovery(dir: string): Discovery | null {
	let raw: string;
	try {
		raw = fs.readFileSync(path.join(dir, DISCOVERY_FILE), "utf8");
	} catch {
		return null;
	}
	return parseDiscovery(raw);
}

export function parseDiscovery(raw: string): Discovery | null {
	let v: unknown;
	try {
		v = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!v || typeof v !== "object") return null;
	const o = v as Record<string, unknown>;
	if (o.protocol !== PROTOCOL_NAME) return null;
	if (typeof o.socket !== "string" || o.socket === "") return null;
	if (typeof o.pid !== "number") return null;
	const versions = Array.isArray(o.versions) ? o.versions.filter((n): n is number => typeof n === "number") : [];
	const s = (o.server && typeof o.server === "object" ? o.server : {}) as Record<string, unknown>;
	const d: Discovery = {
		protocol: PROTOCOL_NAME,
		versions,
		socket: o.socket,
		pid: o.pid,
		server: {
			name: typeof s.name === "string" ? s.name : "Univocal",
			version: typeof s.version === "string" ? s.version : "",
			bundleId: typeof s.bundleId === "string" ? s.bundleId : "",
		},
	};
	const ws = o.ws as Record<string, unknown> | undefined;
	if (ws && typeof ws.url === "string") d.ws = { url: ws.url };
	return d;
}

/** The discovery file only if its `pid` is alive (a dead pid means "not running", SPEC §4.2). */
export function readLiveDiscovery(dir: string): Discovery | null {
	const d = readDiscovery(dir);
	return d && pidAlive(d.pid) ? d : null;
}
