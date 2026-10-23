/**
 * Grant-token storage (SPEC §5.3, §9.5).
 *
 * - {@link KeychainTokenStore}: macOS `security` CLI via `execFile`; service
 *   `com.univocal.connect`, account = server bundle id. Every call has a short
 *   timeout (default 1.5 s) and kills the child when it fires.
 * - {@link FileTokenStore}: a 0600 JSON file in a 0700 directory under
 *   `~/Library/Application Support/obsidian-univocal/` — never the vault.
 * - {@link FallbackTokenStore}: primary, then fallback on error/timeout.
 * - {@link InMemoryTokenStore}: for tests; never touches the Keychain or disk.
 */
import { execFile as nodeExecFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TokenStore } from "./types";

export const TOKEN_SERVICE = "com.univocal.connect";
export const DEFAULT_TOKEN_TIMEOUT_MS = 1500;
/** `security` exit status for errSecItemNotFound. */
const SECURITY_NOT_FOUND = 44;

export type ExecFileCallback = (error: (Error & { code?: number | string | null; killed?: boolean }) | null, stdout: string, stderr: string) => void;
/** The subset of `child_process.execFile` the Keychain store needs (injectable for tests). */
export type ExecFileFn = (file: string, args: string[], options: { timeout: number }, callback: ExecFileCallback) => { kill?: (signal?: NodeJS.Signals) => boolean | void } | void;

const defaultExecFile: ExecFileFn = (file, args, options, callback) =>
	nodeExecFile(file, args, { timeout: options.timeout, encoding: "utf8", windowsHide: true }, (err, stdout, stderr) =>
		callback(err as Parameters<ExecFileCallback>[0], String(stdout ?? ""), String(stderr ?? "")),
	);

export class TokenStoreTimeoutError extends Error {
	constructor(op: string, ms: number) {
		super(`token store ${op} timed out after ${ms} ms`);
		this.name = "TokenStoreTimeoutError";
	}
}

/** Race `p` against a timer; the timer never keeps the process alive. */
export function withTimeout<T>(p: Promise<T>, ms: number, op: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const t = setTimeout(() => reject(new TokenStoreTimeoutError(op, ms)), ms);
		(t as { unref?: () => void }).unref?.();
		p.then(
			(v) => {
				clearTimeout(t);
				resolve(v);
			},
			(e: unknown) => {
				clearTimeout(t);
				reject(e);
			},
		);
	});
}

export interface KeychainTokenStoreOptions {
	service?: string;
	timeoutMs?: number;
	execFile?: ExecFileFn;
	/** Path of the `security` tool. Default `/usr/bin/security`. */
	securityPath?: string;
}

export class KeychainTokenStore implements TokenStore {
	readonly service: string;
	readonly timeoutMs: number;
	private readonly exec: ExecFileFn;
	private readonly security: string;

	constructor(opts: KeychainTokenStoreOptions = {}) {
		this.service = opts.service ?? TOKEN_SERVICE;
		this.timeoutMs = opts.timeoutMs ?? DEFAULT_TOKEN_TIMEOUT_MS;
		this.exec = opts.execFile ?? defaultExecFile;
		this.security = opts.securityPath ?? "/usr/bin/security";
	}

	async get(serverBundleId: string): Promise<string | null> {
		const r = await this.run(["find-generic-password", "-s", this.service, "-a", serverBundleId, "-w"], "read");
		if (r.code === SECURITY_NOT_FOUND) return null;
		if (r.code !== 0) throw new Error(`security find-generic-password exited ${r.code}`);
		const token = r.stdout.replace(/\r?\n$/, "");
		return token === "" ? null : token;
	}

	async set(serverBundleId: string, token: string): Promise<void> {
		// `-U` updates an existing item. The token is passed on argv (visible only to this user).
		const r = await this.run(
			["add-generic-password", "-U", "-s", this.service, "-a", serverBundleId, "-l", `Univocal Connect token (${serverBundleId})`, "-w", token],
			"write",
		);
		if (r.code !== 0) throw new Error(`security add-generic-password exited ${r.code}`);
	}

	async delete(serverBundleId: string): Promise<void> {
		const r = await this.run(["delete-generic-password", "-s", this.service, "-a", serverBundleId], "delete");
		if (r.code !== 0 && r.code !== SECURITY_NOT_FOUND) throw new Error(`security delete-generic-password exited ${r.code}`);
	}

	private run(args: string[], op: string): Promise<{ code: number; stdout: string }> {
		return new Promise((resolve, reject) => {
			let settled = false;
			let child: ReturnType<ExecFileFn> | undefined;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				try {
					child?.kill?.("SIGKILL");
				} catch {
					/* already gone */
				}
				reject(new TokenStoreTimeoutError(op, this.timeoutMs));
			}, this.timeoutMs);
			(timer as { unref?: () => void }).unref?.();
			try {
				child = this.exec(this.security, args, { timeout: this.timeoutMs }, (err, stdout) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					if (!err) return resolve({ code: 0, stdout });
					if (err.killed) return reject(new TokenStoreTimeoutError(op, this.timeoutMs));
					if (typeof err.code === "number") return resolve({ code: err.code, stdout });
					reject(err);
				});
			} catch (e) {
				settled = true;
				clearTimeout(timer);
				reject(e);
			}
		});
	}
}

/** Default fallback location: `~/Library/Application Support/obsidian-univocal/tokens.json`. */
export function defaultTokenFile(appFolder = "obsidian-univocal"): string {
	return path.join(os.homedir(), "Library", "Application Support", appFolder, "tokens.json");
}

/** Tokens in a 0600 JSON file `{ [serverBundleId]: token }`, directory 0700, atomic rename. */
export class FileTokenStore implements TokenStore {
	constructor(readonly file: string = defaultTokenFile()) {}

	async get(serverBundleId: string): Promise<string | null> {
		const map = await this.load();
		const t = map[serverBundleId];
		return typeof t === "string" && t !== "" ? t : null;
	}

	async set(serverBundleId: string, token: string): Promise<void> {
		const map = await this.load();
		map[serverBundleId] = token;
		await this.save(map);
	}

	async delete(serverBundleId: string): Promise<void> {
		const map = await this.load();
		if (!(serverBundleId in map)) return;
		delete map[serverBundleId];
		await this.save(map);
	}

	private async load(): Promise<Record<string, string>> {
		try {
			const v: unknown = JSON.parse(await fs.promises.readFile(this.file, "utf8"));
			return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : {};
		} catch {
			return {};
		}
	}

	private async save(map: Record<string, string>): Promise<void> {
		const dir = path.dirname(this.file);
		await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
		const tmp = `${this.file}.${process.pid}.tmp`;
		await fs.promises.writeFile(tmp, JSON.stringify(map), { mode: 0o600 });
		await fs.promises.chmod(tmp, 0o600);
		await fs.promises.rename(tmp, this.file);
	}
}

/**
 * Primary (Keychain) with a fallback (file). `get` consults the fallback when
 * the primary has nothing or fails; `set` writes the fallback only when the
 * primary fails; `delete` clears both.
 */
export class FallbackTokenStore implements TokenStore {
	constructor(
		readonly primary: TokenStore,
		readonly fallback: TokenStore,
		private readonly onPrimaryError?: (op: string, e: unknown) => void,
	) {}

	async get(serverBundleId: string): Promise<string | null> {
		try {
			const t = await this.primary.get(serverBundleId);
			if (t) return t;
		} catch (e) {
			this.onPrimaryError?.("get", e);
		}
		return this.fallback.get(serverBundleId);
	}

	async set(serverBundleId: string, token: string): Promise<void> {
		try {
			await this.primary.set(serverBundleId, token);
		} catch (e) {
			this.onPrimaryError?.("set", e);
			await this.fallback.set(serverBundleId, token);
			return;
		}
		// The primary has it now; drop any stale fallback copy (best effort).
		await this.fallback.delete(serverBundleId).catch(() => {});
	}

	async delete(serverBundleId: string): Promise<void> {
		const results = await Promise.allSettled([this.primary.delete(serverBundleId), this.fallback.delete(serverBundleId)]);
		if (results[0].status === "rejected") this.onPrimaryError?.("delete", results[0].reason);
		if (results[1].status === "rejected") throw results[1].reason;
	}
}

/** Process-local store for tests and previews. */
export class InMemoryTokenStore implements TokenStore {
	readonly tokens: Map<string, string>;

	constructor(initial: Record<string, string> = {}) {
		this.tokens = new Map(Object.entries(initial));
	}

	async get(serverBundleId: string): Promise<string | null> {
		return this.tokens.get(serverBundleId) ?? null;
	}

	async set(serverBundleId: string, token: string): Promise<void> {
		this.tokens.set(serverBundleId, token);
	}

	async delete(serverBundleId: string): Promise<void> {
		this.tokens.delete(serverBundleId);
	}
}

export interface DefaultTokenStoreOptions {
	timeoutMs?: number;
	file?: string;
	execFile?: ExecFileFn;
	onPrimaryError?: (op: string, e: unknown) => void;
}

/** macOS: Keychain via `security`, falling back to the 0600 file. Elsewhere: the file only. */
export function createDefaultTokenStore(opts: DefaultTokenStoreOptions = {}): TokenStore {
	const file = new FileTokenStore(opts.file ?? defaultTokenFile());
	if (process.platform !== "darwin") return file;
	const keychain = new KeychainTokenStore({ timeoutMs: opts.timeoutMs, execFile: opts.execFile });
	return new FallbackTokenStore(keychain, file, opts.onPrimaryError);
}
