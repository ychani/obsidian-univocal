/**
 * UnivocalClient — Univocal Connect v1 over the Unix socket named in
 * `<connectDir>/connect.json` (SPEC §3–§16).
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import { chunkText, CHUNK_UTF8_BYTES, utf8Length } from "./chunking";
import { DEFAULT_APP_BUNDLE_ID, PROTOCOL_NAME, PROTOCOL_VERSIONS, readLiveDiscovery, resolveConnectDir, tokenAccount } from "./discovery";
import { Emitter, noopLogger, unref } from "./emitter";
import { UnivocalError } from "./errors";
import { DEFAULT_MAX_FRAME_BYTES, encodeFrame, NdjsonDecoder, type WireMessage } from "./ndjson";
import { ReadingSessionImpl, type SessionHost } from "./session";
import { DEFAULT_TOKEN_TIMEOUT_MS, withTimeout } from "./tokenStore";
import type {
	ConnectCallOptions,
	ConnectionState,
	ConnectOptions,
	ConsentDeniedReason,
	Discovery,
	EndedReason,
	Limits,
	Logger,
	ReadDeclineReason,
	ReadingSession,
	ReadOptions,
	ReadRequest,
	ReadRequestAnswer,
	ReadRequestHandler,
	ServerInfo,
	SessionState,
	UnivocalClientEvents,
	Unsubscribe,
	Voice,
} from "./types";

const CLIENT_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const DEFAULT_LIMITS: Limits = { maxFrameBytes: DEFAULT_MAX_FRAME_BYTES, maxTextBytes: 8 * 1_048_576, rate: { min: 0.25, max: 4 } };
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_LAUNCH_TIMEOUT_MS = 10_000;
const DEFAULT_RECONNECT_DELAYS_MS = [1000, 2000, 4000];
const DEFAULT_POLL_INTERVAL_MS = 5000;
/** SPEC §5.3: no re-prompt for 10 minutes after `unauthorized{revoked}`. */
const REVOCATION_HOLD_MS = 10 * 60 * 1000;
const HOTKEY_TARGET = "hotkey-target";
const HOTKEY_ROUTING = "hotkey-routing";
const SESSION_EVENTS = new Set(["state", "sentence", "word", "progress", "rate", "ended"]);
const SESSION_STATES = new Set<SessionState>(["loading", "playing", "paused"]);
const ENDED_REASONS = new Set<EndedReason>(["finished", "stopped", "preempted", "error", "revoked"]);
const DENIED_REASONS = new Set<ConsentDeniedReason>(["user", "timeout", "disabled", "rateLimited", "quiet"]);

type Timer = ReturnType<typeof setTimeout>;
type HotkeyState = "pending" | "accepted" | "answered";

interface Pending {
	resolve(msg: WireMessage): void;
	reject(e: UnivocalError): void;
}

interface Link {
	id: number;
	socket: net.Socket;
	discovery: Discovery;
	quiet: boolean;
	ready: boolean;
	server?: ServerInfo;
	serverCapabilities: string[];
	limits: Limits;
	handshake?: { resolve(s: ServerInfo): void; reject(e: UnivocalError): void; timer?: Timer };
	pending: Map<number, Pending>;
	sessions: Map<string, ReadingSessionImpl>;
	hotkey: Map<string, HotkeyState>;
	grantedToken?: string;
	fatal?: UnivocalError;
	closedByUser: boolean;
	closed: boolean;
}

/** Why a quiet attempt did not connect (internal; drives the reconnect policy). */
type QuietOutcome = "connected" | "noServer" | "noToken" | "denied" | "revoked" | "failed";

export class UnivocalClient {
	readonly options: ConnectOptions;

	private readonly log: Logger;
	private readonly events: Emitter<UnivocalClientEvents>;
	private _state: ConnectionState = { kind: "disconnected" };
	private link?: Link;
	private nextLinkId = 1;
	private nextRequestId = 1;
	private sessionSeq = 0;
	/** Token of the newest session started on this client; older sessions' events are dropped. */
	private activeSessionToken = 0;
	private inflight?: { quiet: boolean; promise: Promise<ServerInfo> };
	/** Bumped by disconnect()/setConnectDir(): in-flight connects notice and abort. */
	private generation = 0;
	private revokedUntil = 0;
	private readRequestHandler?: ReadRequestHandler;
	/** Last server bundle id seen in a discovery file (keys the token store, see `tokenKey`). */
	private lastServerBundleId?: string;

	// Connection health
	private autoReconnect = false;
	private reconnectAttempt = 0;
	private reconnectTimer?: Timer;
	private watcher?: fs.FSWatcher;
	private pollTimer?: ReturnType<typeof setInterval>;
	private watchDebounce?: Timer;
	private lastSeenPid: number | null = null;
	/** Pending token writes (tests await these via `whenIdle`). */
	private tokenWrites = new Set<Promise<unknown>>();

	constructor(options: ConnectOptions) {
		this.options = { ...options, appBundleId: options.appBundleId ?? DEFAULT_APP_BUNDLE_ID };
		this.log = options.logger ?? noopLogger;
		this.events = new Emitter<UnivocalClientEvents>(this.log);
		if (!CLIENT_ID_RE.test(options.clientInfo.id)) {
			throw new UnivocalError("invalidArgument", "clientInfo.id must match [A-Za-z0-9._-]{1,128}.");
		}
	}

	// -----------------------------------------------------------------------
	// Public surface
	// -----------------------------------------------------------------------

	get state(): ConnectionState {
		return this._state;
	}

	/** Server info once connected, else `null`. */
	get server(): ServerInfo | null {
		return this.link?.ready && this.link.server ? this.link.server : null;
	}

	/** Server capabilities once connected (empty otherwise). */
	get serverCapabilities(): string[] {
		return this.link?.ready ? [...this.link.serverCapabilities] : [];
	}

	get limits(): Limits | null {
		return this.link?.ready ? this.link.limits : null;
	}

	/** The connect dir currently in use (override → env → default). */
	get connectDir(): string {
		return resolveConnectDir(this.options.connectDir, this.options.appBundleId);
	}

	/** `notInstalled` / `installed` (not running) / `running` (live connect.json + pid). */
	async availability(): Promise<"notInstalled" | "installed" | "running"> {
		if (readLiveDiscovery(this.connectDir)) return "running";
		return (await this.isInstalled()) ? "installed" : "notInstalled";
	}

	/**
	 * Read discovery → (optionally launch) → `net.connect` → `hello` (with stored
	 * token) → handle consent → resolves on `welcome`. On `consentGranted` the
	 * token is stored and hello is NOT re-sent. On `consentDenied{quiet}` the
	 * token is deleted. Rejects with a `UnivocalError` whose `connectError` is a
	 * {@link ConnectError}. Idempotent while connected.
	 */
	async connect(opts: ConnectCallOptions = {}): Promise<ServerInfo> {
		const quiet = opts.quiet === true;
		for (;;) {
			if (this.link?.ready && this.link.server && !this.link.closed) return this.link.server;
			const current = this.inflight;
			if (!current) break;
			try {
				return await current.promise;
			} catch (e) {
				// A quiet connect-at-launch was refused; a user-initiated caller may prompt.
				if (current.quiet && !quiet && e instanceof UnivocalError && e.code === "consentDenied") continue;
				throw e;
			}
		}
		// A wake (SPEC §16.5) is the server inviting us back after the user clicked
		// Connect in Univocal, so the post-revoke hold doesn't apply to it.
		if (opts.wakeRequestId) this.revokedUntil = 0;
		if (Date.now() < this.revokedUntil) {
			throw new UnivocalError("unauthorized", "Univocal revoked this app's access. Try again later.", { fatal: true, reason: "revoked" });
		}
		const promise = this.establish(opts);
		const entry = { quiet, promise };
		this.inflight = entry;
		try {
			return await promise;
		} finally {
			if (this.inflight === entry) this.inflight = undefined;
		}
	}

	/**
	 * Quiet connect for hotkey routing (SPEC §16.9): only when a token exists
	 * AND connect.json is live; sends `hello{quiet:true}`; never launches or
	 * prompts. Resolves `null` when there is no token, the server is not
	 * running, the server answered `consentDenied{quiet}` (token deleted), or
	 * the attempt failed (see `state.error`). Also turns on connection health:
	 * the client watches the connect dir and reconnects quietly with backoff.
	 */
	async connectQuietly(): Promise<ServerInfo | null> {
		this.autoReconnect = true;
		this.startWatching();
		const outcome = await this.quietAttempt();
		return outcome === "connected" ? this.server : null;
	}

	/** Change the connect dir live; reconnects (quietly) if connected or watching. */
	setConnectDir(dir: string | undefined): void {
		if (dir === this.options.connectDir) return;
		this.options.connectDir = dir;
		const wasActive = this.autoReconnect || !!this.link;
		this.generation++;
		this.clearReconnectTimer();
		if (this.link) this.closeLink(this.link, true);
		this.lastSeenPid = null;
		this.reconnectAttempt = 0;
		if (this.watcher || this.pollTimer) {
			this.stopWatching();
			this.startWatching();
		}
		this.setState({ kind: "disconnected" });
		if (wasActive) {
			this.autoReconnect = true;
			this.startWatching();
			void this.quietAttempt().then((o) => {
				if (o === "failed") this.scheduleReconnect();
			});
		}
	}

	/** Close the socket and stop reconnecting; the live session (if any) ends (`ended{stopped}` locally, silently server-side). */
	disconnect(): void {
		this.autoReconnect = false;
		this.generation++;
		this.clearReconnectTimer();
		this.stopWatching();
		if (this.link) this.closeLink(this.link, true);
		this.setState({ kind: "disconnected" });
	}

	/** Forget the stored token (the next connect re-prompts in Univocal) and disconnect. */
	async forgetAuthorization(): Promise<void> {
		const key = this.tokenKey(readLiveDiscovery(this.connectDir)?.server.bundleId ?? this.lastServerBundleId);
		this.revokedUntil = 0;
		this.disconnect();
		await this.tokenOp("delete", () => this.options.tokenStore.delete(key));
	}

	/**
	 * Start a session (SPEC §5.4). Connects first (no launch) if needed. Chunks
	 * text over 512 KiB UTF-8 at `\n\n` boundaries (`read{more:true}` +
	 * `append`), refuses text over `limits.maxTextBytes` (`textTooLarge`).
	 * Resolves after `ok` for every chunk. A newer session ends the previous
	 * one locally (`ended{preempted}`) before its own events can arrive.
	 */
	async read(text: string, opts: ReadOptions = {}): Promise<ReadingSession> {
		await this.connect();
		const link = this.link;
		if (!link?.ready) throw new UnivocalError("disconnected", "Not connected to Univocal.");
		return this.startSession(link, text, opts, opts.requestId);
	}

	/**
	 * Append text to a session opened with `more:true` (virtualised reading
	 * view). `more:false` marks the final chunk. Offsets continue globally.
	 */
	async append(session: ReadingSession, text: string, more: boolean): Promise<void> {
		const link = this.link;
		const s = link?.sessions.get(session.id);
		if (!link || !s || s !== session || s.ended) {
			throw new UnivocalError("sessionEnded", "The session is no longer live.", { sessionId: session.id });
		}
		if (!s.open) throw new UnivocalError("invalidArgument", "The session was not opened with more:true.", { sessionId: s.id });
		const bytes = utf8Length(text);
		if (s.textBytes + bytes > link.limits.maxTextBytes) {
			throw new UnivocalError("textTooLarge", `The text would exceed ${link.limits.maxTextBytes} bytes.`, { sessionId: s.id });
		}
		const pieces = text === "" ? [""] : chunkText(text, this.chunkBudget(link));
		await this.sendPieces(link, s, pieces, more, (piece, pieceMore) => ({ type: "append", sessionId: s.id, text: piece, more: pieceMore }));
	}

	/** `listVoices` (capability `voices`). */
	async listVoices(): Promise<{ default?: string; voices: Voice[] }> {
		await this.connect();
		const link = this.link;
		if (!link?.ready) throw new UnivocalError("disconnected", "Not connected to Univocal.");
		if (!link.serverCapabilities.includes("voices")) throw new UnivocalError("unsupported", "This Univocal does not offer a voice list.");
		const reply = await this.request(link, { type: "listVoices" });
		const voices: Voice[] = [];
		for (const v of Array.isArray(reply.voices) ? reply.voices : []) {
			const o = v as Record<string, unknown>;
			if (typeof o?.id !== "string") continue;
			const voice: Voice = { id: o.id, name: typeof o.name === "string" ? o.name : o.id };
			if (typeof o.lang === "string") voice.lang = o.lang;
			voices.push(voice);
		}
		const out: { default?: string; voices: Voice[] } = { voices };
		if (typeof reply.default === "string") out.default = reply.default;
		return out;
	}

	/**
	 * Register the single `readRequest` handler (replaces any previous one).
	 * The client turns the returned answer into `read{requestId}` /
	 * `readAccepted` + `read` / `readDecline`. Returns an unregister function;
	 * with no handler registered the client declines `other`.
	 */
	onReadRequest(handler: ReadRequestHandler): Unsubscribe {
		this.readRequestHandler = handler;
		return () => {
			if (this.readRequestHandler === handler) this.readRequestHandler = undefined;
		};
	}

	on<K extends keyof UnivocalClientEvents>(event: K, listener: (payload: UnivocalClientEvents[K]) => void): Unsubscribe {
		return this.events.on(event, listener);
	}

	/** Test hook: resolves when pending token-store writes have settled. */
	async whenIdle(): Promise<void> {
		while (this.tokenWrites.size > 0) await Promise.allSettled([...this.tokenWrites]);
	}

	// -----------------------------------------------------------------------
	// Connection establishment
	// -----------------------------------------------------------------------

	private async establish(opts: ConnectCallOptions): Promise<ServerInfo> {
		const gen = this.generation;
		const quiet = opts.quiet === true;
		try {
			this.setState({ kind: "connecting" });
			const dir = this.connectDir;
			let discovery = readLiveDiscovery(dir);
			let deadline: number | undefined;
			if (!discovery) {
				if (!opts.launch) {
					const installed = await this.isInstalled();
					throw new UnivocalError(installed ? "notRunning" : "notInstalled", installed ? "Univocal is not running." : "Univocal is not installed.");
				}
				if (!(await this.isInstalled())) throw new UnivocalError("notInstalled", "Univocal is not installed.");
				this.checkGeneration(gen);
				this.setState({ kind: "launching" });
				const bundleId = this.options.appBundleId ?? DEFAULT_APP_BUNDLE_ID;
				this.log.info(`[univocal] launching ${bundleId}`);
				try {
					await (this.options.launcher ?? defaultLauncher)(bundleId);
				} catch (e) {
					throw new UnivocalError("notInstalled", `Univocal could not be launched: ${(e as Error).message ?? e}`);
				}
				deadline = Date.now() + (this.options.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS);
				for (;;) {
					this.checkGeneration(gen);
					discovery = readLiveDiscovery(dir);
					if (discovery) break;
					if (Date.now() >= deadline) throw new UnivocalError("timeout", "Univocal did not start.");
					await sleep(250);
				}
				this.setState({ kind: "connecting" });
			}
			if (!discovery.versions.some((v) => PROTOCOL_VERSIONS.includes(v))) {
				throw new UnivocalError("unsupportedVersion", `Univocal speaks protocol versions [${discovery.versions.join(", ")}]; this client needs [1].`, { fatal: true });
			}
			if (discovery.server.bundleId) this.lastServerBundleId = discovery.server.bundleId;
			// The token read runs alongside the socket connect and can never stall the hello.
			const tokenPromise = this.readToken(this.tokenKey(discovery.server.bundleId));
			const socket = await this.openSocket(discovery.socket, deadline, gen);
			const token = await tokenPromise;
			if (gen !== this.generation) {
				socket.destroy();
				throw cancelled();
			}
			return await this.handshake(socket, discovery, token, quiet, opts.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS, opts.wakeRequestId);
		} catch (e) {
			const err = e instanceof UnivocalError ? e : new UnivocalError("transport", (e as Error)?.message ?? String(e));
			if (gen === this.generation) this.setState({ kind: "disconnected", error: err.connectError });
			this.log.debug(`[univocal] connect failed code=${err.code}${err.reason ? ` reason=${err.reason}` : ""}`);
			throw err;
		}
	}

	private checkGeneration(gen: number): void {
		if (gen !== this.generation) throw cancelled();
	}

	private async openSocket(path: string, deadline: number | undefined, gen: number): Promise<net.Socket> {
		let delay = 100;
		for (;;) {
			try {
				return await connectSocket(path);
			} catch (e) {
				this.checkGeneration(gen);
				const code = (e as NodeJS.ErrnoException).code;
				if (deadline === undefined || Date.now() + delay >= deadline) {
					if (code === "ENOENT" || code === "ECONNREFUSED") throw new UnivocalError("notRunning", "Univocal is not accepting connections.");
					throw new UnivocalError("transport", `Could not connect to Univocal (${code ?? "error"}).`);
				}
				await sleep(delay);
				delay = Math.min(delay * 2, 1000);
			}
		}
	}

	private handshake(
		socket: net.Socket,
		discovery: Discovery,
		token: string | null,
		quiet: boolean,
		timeoutMs: number,
		wakeRequestId?: string,
	): Promise<ServerInfo> {
		const link: Link = {
			id: this.nextLinkId++,
			socket,
			discovery,
			quiet,
			ready: false,
			serverCapabilities: [],
			limits: DEFAULT_LIMITS,
			pending: new Map(),
			sessions: new Map(),
			hotkey: new Map(),
			closedByUser: false,
			closed: false,
		};
		if (this.link && !this.link.closed) this.closeLink(this.link, true);
		this.link = link;
		const decoder = new NdjsonDecoder({
			message: (msg) => this.dispatch(link, msg),
			malformed: (n) => this.log.debug(`[univocal] ignoring malformed frame bytes=${n}`),
			overflow: (n) => {
				link.fatal = new UnivocalError("protocolError", `Server frame of ${n} bytes exceeds the frame limit.`, { fatal: true });
				this.closeLink(link, false);
			},
		});
		socket.on("data", (chunk: Buffer) => decoder.push(chunk));
		socket.on("error", (e) => {
			if (!link.fatal) link.fatal = new UnivocalError("transport", `Connection error (${(e as NodeJS.ErrnoException).code ?? e.message}).`);
		});
		socket.on("close", () => this.closeLink(link, false));

		const c = this.options.clientInfo;
		const client: Record<string, unknown> = { id: c.id, name: c.name, version: c.version };
		if (c.bundleId) client.bundleId = c.bundleId;
		const hello: Record<string, unknown> = {
			type: "hello",
			protocol: PROTOCOL_NAME,
			versions: PROTOCOL_VERSIONS,
			client,
			capabilities: [...new Set(this.options.capabilities)],
		};
		if (token) hello.token = token;
		if (quiet) hello.quiet = true;
		if (wakeRequestId) hello.wakeRequestId = wakeRequestId;
		this.log.debug(`[univocal] hello client=${c.id} token=${token ? "present" : "absent"} quiet=${quiet}`);

		return new Promise<ServerInfo>((resolve, reject) => {
			link.handshake = { resolve, reject };
			this.armHandshakeTimer(link, timeoutMs, "Univocal did not answer the handshake.");
			try {
				socket.write(encodeFrame(hello));
			} catch (e) {
				link.fatal = e instanceof UnivocalError ? e : new UnivocalError("transport", String(e));
				this.closeLink(link, false);
			}
		});
	}

	private armHandshakeTimer(link: Link, ms: number, message: string): void {
		const hs = link.handshake;
		if (!hs) return;
		if (hs.timer) clearTimeout(hs.timer);
		hs.timer = unref(
			setTimeout(() => {
				if (link.handshake !== hs) return;
				link.fatal = new UnivocalError("timeout", message);
				this.closeLink(link, false);
			}, ms),
		);
	}

	// -----------------------------------------------------------------------
	// Inbound
	// -----------------------------------------------------------------------

	private dispatch(link: Link, msg: WireMessage): void {
		if (link.closed) return;
		switch (msg.type) {
			case "consentPending":
				return this.onConsentPending(link, msg);
			case "consentGranted":
				return this.onConsentGranted(link, msg);
			case "consentDenied":
				return this.onConsentDenied(link, msg);
			case "welcome":
				return this.onWelcome(link, msg);
			case "ok":
			case "pong":
			case "voices": {
				const id = msg.id;
				if (typeof id === "number") {
					const p = link.pending.get(id);
					if (p) {
						link.pending.delete(id);
						p.resolve(msg);
					}
				}
				return;
			}
			case "error":
				return this.onError(link, msg);
			case "ping": {
				const pong: Record<string, unknown> = { type: "pong" };
				if (msg.id !== undefined) pong.id = msg.id;
				this.write(link, pong);
				return;
			}
			case "readRequest":
				return this.onReadRequestMessage(link, msg);
			default:
				if (SESSION_EVENTS.has(msg.type)) return this.routeSessionEvent(link, msg);
			// Unknown types are ignored (SPEC §3.3, C3).
		}
	}

	private onConsentPending(link: Link, msg: WireMessage): void {
		if (!link.handshake) return;
		const requestId = str(msg.requestId) ?? "";
		const timeoutSeconds = typeof msg.timeoutSeconds === "number" ? msg.timeoutSeconds : 120;
		this.setState({ kind: "awaitingConsent" });
		this.events.emit("consent", { kind: "pending", requestId, timeoutSeconds });
		// The user may take up to `timeoutSeconds` to answer the prompt.
		this.armHandshakeTimer(link, timeoutSeconds * 1000 + 10_000, "No answer from the approval prompt in Univocal.");
	}

	private onConsentGranted(link: Link, msg: WireMessage): void {
		const token = str(msg.token);
		if (token) link.grantedToken = token;
		this.events.emit("consent", { kind: "granted", requestId: str(msg.requestId) ?? "" });
		// `welcome` follows on this connection; hello is NOT re-sent (SPEC §5.3).
	}

	private onConsentDenied(link: Link, msg: WireMessage): void {
		const raw = str(msg.reason) ?? "user";
		const reason = (DENIED_REASONS.has(raw as ConsentDeniedReason) ? raw : "user") as ConsentDeniedReason;
		this.events.emit("consent", { kind: "denied", requestId: str(msg.requestId) ?? "", reason });
		if (reason === "quiet") {
			// The presented token is no longer valid; never retry without a user action.
			const key = this.tokenKey(link.discovery.server.bundleId);
			void this.tokenOp("delete", () => this.options.tokenStore.delete(key));
		}
		link.fatal = new UnivocalError("consentDenied", denialMessage(reason), { fatal: true, reason });
		this.closeLink(link, false);
	}

	private onWelcome(link: Link, msg: WireMessage): void {
		const version = typeof msg.version === "number" ? msg.version : 0;
		if (!PROTOCOL_VERSIONS.includes(version)) {
			link.fatal = new UnivocalError("unsupportedVersion", `Univocal answered with protocol version ${version}.`, { fatal: true });
			this.closeLink(link, false);
			return;
		}
		const s = obj(msg.server);
		const server: ServerInfo = {
			name: str(s.name) ?? link.discovery.server.name ?? "Univocal",
			version: str(s.version) ?? link.discovery.server.version ?? "",
			bundleId: str(s.bundleId) ?? (link.discovery.server.bundleId || (this.options.appBundleId ?? DEFAULT_APP_BUNDLE_ID)),
		};
		const l = obj(msg.limits);
		const r = obj(l.rate);
		const lo = num(r.min) ?? DEFAULT_LIMITS.rate.min;
		const hi = num(r.max) ?? DEFAULT_LIMITS.rate.max;
		link.limits = {
			maxFrameBytes: num(l.maxFrameBytes) ?? DEFAULT_LIMITS.maxFrameBytes,
			maxTextBytes: num(l.maxTextBytes) ?? DEFAULT_LIMITS.maxTextBytes,
			rate: { min: Math.min(lo, hi), max: Math.max(lo, hi) },
		};
		link.serverCapabilities = Array.isArray(msg.capabilities) ? msg.capabilities.filter((c): c is string => typeof c === "string") : [];
		link.server = server;
		link.ready = true;
		if (link.grantedToken) {
			const token = link.grantedToken;
			link.grantedToken = undefined;
			// Same key the next hello reads (`tokenKey`). Fire-and-forget: never delays the session.
			const key = this.tokenKey(link.discovery.server.bundleId);
			void this.tokenOp("set", () => this.options.tokenStore.set(key, token));
		}
		const hs = link.handshake;
		link.handshake = undefined;
		if (hs?.timer) clearTimeout(hs.timer);
		this.autoReconnect = true;
		this.reconnectAttempt = 0;
		this.lastSeenPid = link.discovery.pid;
		this.clearReconnectTimer();
		this.startWatching();
		this.setState({ kind: "connected", server, capabilities: [...link.serverCapabilities], limits: link.limits });
		this.log.info(`[univocal] connected to ${server.name} ${server.version}`);
		hs?.resolve(server);
	}

	private onError(link: Link, msg: WireMessage): void {
		const err = UnivocalError.fromWire(msg);
		this.log.debug(`[univocal] server error code=${err.code} fatal=${err.fatal}`);
		if (err.code === "unauthorized" && err.reason === "revoked") {
			this.revokedUntil = Date.now() + REVOCATION_HOLD_MS;
			const key = this.tokenKey(link.discovery.server.bundleId);
			void this.tokenOp("delete", () => this.options.tokenStore.delete(key));
		}
		if (err.fatal) link.fatal = err;
		const id = msg.id;
		const pending = typeof id === "number" ? link.pending.get(id) : undefined;
		if (pending && typeof id === "number") {
			link.pending.delete(id);
			pending.reject(err);
		} else if (err.sessionId && link.sessions.has(err.sessionId)) {
			const s = link.sessions.get(err.sessionId);
			if (s && s.token >= this.activeSessionToken) s.deliver("error", err.toProtocolError());
		} else if (err.code === "unknownRequest") {
			// A late hotkey answer: cleared silently (C20).
		} else if (link.ready) {
			this.events.emit("error", err.toProtocolError());
		}
		if (err.fatal && link.handshake) this.closeLink(link, false);
	}

	private routeSessionEvent(link: Link, msg: WireMessage): void {
		const sid = str(msg.sessionId);
		const s = sid ? link.sessions.get(sid) : undefined;
		if (!s) return; // unknown / already ended / superseded session
		if (s.token < this.activeSessionToken) {
			// Late event from a superseded session (it already got a local `ended`).
			link.sessions.delete(s.id);
			return;
		}
		switch (msg.type) {
			case "state": {
				const st = str(msg.state) as SessionState | undefined;
				if (!st || !SESSION_STATES.has(st)) return;
				const detail = str(msg.detail);
				s.deliver("state", detail === undefined ? { state: st } : { state: st, detail });
				return;
			}
			case "sentence":
			case "word": {
				const a = num(msg.start);
				const b = num(msg.end);
				if (a === undefined || b === undefined || !Number.isInteger(a) || !Number.isInteger(b) || a < 0 || a >= b || b > s.textLength) {
					this.log.debug(`[univocal] dropping out-of-range ${msg.type} session=${s.id}`);
					return;
				}
				s.deliver(msg.type, { start: a, end: b });
				return;
			}
			case "progress": {
				const o = num(msg.offset);
				if (o !== undefined) s.deliver("progress", { offset: o });
				return;
			}
			case "rate": {
				const r = num(msg.rate);
				if (r !== undefined) s.deliver("rate", { rate: r });
				return;
			}
			case "ended": {
				const raw = str(msg.reason) as EndedReason | undefined;
				const reason: EndedReason = raw && ENDED_REASONS.has(raw) ? raw : "error";
				const by = str(msg.by);
				link.sessions.delete(s.id);
				s.deliver("ended", by === undefined ? { reason } : { reason, by });
				return;
			}
		}
	}

	// -----------------------------------------------------------------------
	// Sessions
	// -----------------------------------------------------------------------

	private chunkBudget(link: Link): number {
		return Math.max(1024, Math.min(CHUNK_UTF8_BYTES, Math.floor(link.limits.maxFrameBytes / 2)));
	}

	private validateRead(link: Link, text: string, opts: ReadOptions): void {
		if (text === "" && !opts.more) throw new UnivocalError("invalidArgument", "Nothing to read: the text is empty.");
		const start = opts.startOffset ?? 0;
		if (!Number.isInteger(start) || start < 0 || start > text.length) {
			throw new UnivocalError("invalidOffset", `startOffset ${start} is outside 0…${text.length}.`);
		}
		const bytes = utf8Length(text);
		if (bytes > link.limits.maxTextBytes) {
			throw new UnivocalError("textTooLarge", `The text is ${bytes} bytes; Univocal accepts at most ${link.limits.maxTextBytes}.`);
		}
		if (opts.sessionId && link.sessions.get(opts.sessionId)?.ended === false) {
			throw new UnivocalError("sessionExists", `Session ${opts.sessionId} is still live.`);
		}
	}

	private async startSession(link: Link, text: string, opts: ReadOptions, requestId: string | undefined): Promise<ReadingSessionImpl> {
		this.validateRead(link, text, opts);
		const sid = opts.sessionId ?? randomUUID();
		const preempt = requestId !== undefined ? true : opts.preempt !== false;
		const token = ++this.sessionSeq;
		const superseded: ReadingSessionImpl[] = [];
		if (preempt) {
			// End older sessions locally first, so no late event of theirs can follow the new session's events.
			this.activeSessionToken = token;
			for (const old of [...link.sessions.values()]) {
				if (old.token < token && !old.ended) {
					link.sessions.delete(old.id);
					superseded.push(old);
					old.deliver("ended", { reason: "preempted", by: this.options.clientInfo.name });
				}
			}
		}
		const session = new ReadingSessionImpl(sid, token, this.sessionHost, this.log);
		link.sessions.set(sid, session);
		const pieces = text === "" ? [""] : chunkText(text, this.chunkBudget(link));
		this.log.debug(`[univocal] read session=${sid} utf16=${text.length} chunks=${pieces.length}${requestId ? ` request=${requestId}` : ""}`);
		try {
			await this.sendPieces(link, session, pieces, opts.more === true, (piece, more, index) => {
				if (index > 0) return { type: "append", sessionId: sid, text: piece, more };
				const m: Record<string, unknown> = { type: "read", sessionId: sid, text: piece, preempt, more };
				if (opts.lang) m.lang = opts.lang;
				if (opts.voice !== undefined) m.voice = opts.voice;
				if (opts.rate !== undefined) m.rate = opts.rate;
				if (opts.startOffset) m.startOffset = opts.startOffset;
				if (opts.title) m.meta = { title: opts.title };
				if (requestId !== undefined) m.requestId = requestId;
				return m;
			});
		} catch (e) {
			const sentAny = session.acked; // the server accepted the opening read
			if (link.sessions.get(sid) === session) link.sessions.delete(sid);
			if (sentAny && !link.closed) this.write(link, { type: "stop", sessionId: sid }); // best effort
			// The server never took over, so the sessions we ended locally may still be playing: stop them.
			for (const old of superseded) this.write(link, { type: "stop", sessionId: old.id });
			if (!session.ended) session.deliver("ended", { reason: "error" });
			session.release();
			throw e;
		}
		session.release();
		return session;
	}

	/**
	 * Send `pieces` in order, each acknowledged by `ok`. A piece whose frame
	 * exceeds `maxFrameBytes` after JSON escaping is split and retried.
	 */
	private async sendPieces(
		link: Link,
		session: ReadingSessionImpl,
		pieces: string[],
		moreAfter: boolean,
		build: (piece: string, more: boolean, index: number) => Record<string, unknown>,
	): Promise<void> {
		const queue = [...pieces];
		let index = 0;
		const firstIsRead = session.textLength === 0 && session.textBytes === 0 && !session.open && !session.started;
		while (queue.length > 0) {
			const piece = queue[0] as string;
			const more = queue.length > 1 || moreAfter;
			const msg = build(piece, more, firstIsRead ? index : index + 1);
			session.started = true;
			let frameMsg: Record<string, unknown>;
			try {
				frameMsg = { ...msg, id: Number.MAX_SAFE_INTEGER };
				encodeFrame(frameMsg, link.limits.maxFrameBytes);
			} catch (e) {
				if (e instanceof UnivocalError && e.code === "textTooLarge" && utf8Length(piece) > 1024) {
					queue.splice(0, 1, ...chunkText(piece, Math.max(512, Math.floor(utf8Length(piece) / 2))));
					continue;
				}
				throw e;
			}
			// Count the text as sent before awaiting `ok`: events that arrive in the same read
			// as the `ok` are range-checked against it synchronously.
			queue.shift();
			session.textLength += piece.length;
			session.textBytes += utf8Length(piece);
			session.open = more;
			index++;
			await this.request(link, msg);
			session.acked = true;
		}
	}

	private readonly sessionHost: SessionHost = {
		control: async (session, type, fields = {}) => {
			const link = this.link;
			if (session.ended || !link || link.closed || link.sessions.get(session.id) !== session) {
				throw new UnivocalError("sessionEnded", "The session is no longer live.", { sessionId: session.id });
			}
			await this.request(link, { type, sessionId: session.id, ...fields });
		},
	};

	// -----------------------------------------------------------------------
	// Hotkey routing (SPEC §5.11, §16)
	// -----------------------------------------------------------------------

	private onReadRequestMessage(link: Link, msg: WireMessage): void {
		if (!link.ready || !this.options.capabilities.includes(HOTKEY_TARGET) || !link.serverCapabilities.includes(HOTKEY_ROUTING)) {
			this.log.debug("[univocal] ignoring readRequest: hotkey routing was not negotiated");
			return;
		}
		const requestId = str(msg.requestId);
		if (!requestId || msg.trigger !== "hotkey") return; // unknown trigger: ignore (SPEC §5.11)
		if (link.hotkey.has(requestId)) return; // duplicate
		const answerMs = Math.max(1, num(msg.answerMs) ?? 300);
		const req: ReadRequest = {
			requestId,
			trigger: "hotkey",
			prefer: msg.prefer === "document" ? "document" : "selection",
			answerMs,
			acceptedMs: Math.max(answerMs, num(msg.acceptedMs) ?? 1500),
		};
		link.hotkey.set(requestId, "pending");
		this.log.debug(`[univocal] readRequest request=${requestId} prefer=${req.prefer}`);
		const handler = this.readRequestHandler;
		if (!handler) return this.decline(link, requestId, "other", "noHandler");
		let answer: ReadRequestAnswer;
		try {
			answer = handler(req);
		} catch (e) {
			this.log.warn("[univocal] readRequest handler threw", e);
			return this.decline(link, requestId, "other", "handlerError");
		}
		void this.answer(link, req, answer);
	}

	private async answer(link: Link, req: ReadRequest, answer: ReadRequestAnswer): Promise<void> {
		const rid = req.requestId;
		try {
			switch (answer?.kind) {
				case "decline":
					return this.decline(link, rid, answer.reason, answer.detail);
				case "read":
					return await this.answerWithRead(link, rid, answer.text, answer.options, answer.onSession);
				case "accept": {
					link.hotkey.set(rid, "accepted");
					this.write(link, { type: "readAccepted", requestId: rid });
					let produced: { text: string; options?: ReadOptions } | null;
					try {
						produced = await answer.produce();
					} catch (e) {
						this.log.warn("[univocal] readRequest produce() threw", e);
						return this.decline(link, rid, "other", "produceError");
					}
					if (!produced) return this.decline(link, rid, "noContent");
					return await this.answerWithRead(link, rid, produced.text, produced.options, answer.onSession);
				}
				default:
					return this.decline(link, rid, "other", "badAnswer");
			}
		} catch (e) {
			if (e instanceof UnivocalError && e.code === "unknownRequest") {
				this.log.debug(`[univocal] request=${rid} was no longer pending (too late)`);
				return;
			}
			this.log.warn(`[univocal] answering request=${rid} failed`, e instanceof UnivocalError ? e.code : e);
		}
	}

	private async answerWithRead(
		link: Link,
		rid: string,
		text: string,
		options: ReadOptions | undefined,
		onSession: ((s: ReadingSession) => void) | undefined,
	): Promise<void> {
		if (link.closed || this.link !== link) return;
		const opts: ReadOptions = { ...options, requestId: rid, preempt: true };
		try {
			this.validateRead(link, text, opts);
		} catch {
			// Nothing valid to read: decline so Univocal falls back at once.
			return this.decline(link, rid, "noContent", "invalidText");
		}
		link.hotkey.set(rid, "answered");
		const session = await this.startSession(link, text, opts, rid);
		try {
			onSession?.(session);
		} catch (e) {
			this.log.warn("[univocal] onSession threw", e);
		}
	}

	private decline(link: Link, rid: string, reason: ReadDeclineReason, detail?: string): void {
		if (link.hotkey.get(rid) === "answered") return;
		link.hotkey.set(rid, "answered");
		const m: Record<string, unknown> = { type: "readDecline", requestId: rid, reason };
		if (detail) m.detail = detail;
		this.write(link, m);
		this.log.debug(`[univocal] readDecline request=${rid} reason=${reason}`);
	}

	// -----------------------------------------------------------------------
	// Outbound
	// -----------------------------------------------------------------------

	private request(link: Link, message: Record<string, unknown>): Promise<WireMessage> {
		if (link.closed) return Promise.reject(link.fatal ?? new UnivocalError("disconnected", "Not connected to Univocal."));
		const id = this.nextRequestId++;
		let frame: Buffer;
		try {
			frame = encodeFrame({ ...message, id }, link.limits.maxFrameBytes);
		} catch (e) {
			return Promise.reject(e);
		}
		return new Promise<WireMessage>((resolve, reject) => {
			link.pending.set(id, { resolve, reject });
			link.socket.write(frame);
		});
	}

	/** Unacknowledged messages (`readAccepted`, `readDecline`, `pong`, best-effort `stop`). */
	private write(link: Link, message: Record<string, unknown>): void {
		if (link.closed) return;
		try {
			link.socket.write(encodeFrame(message, link.limits.maxFrameBytes));
		} catch (e) {
			this.log.warn("[univocal] could not send frame", e);
		}
	}

	// -----------------------------------------------------------------------
	// Teardown & state
	// -----------------------------------------------------------------------

	private closeLink(link: Link, byUser: boolean): void {
		if (link.closed) return;
		link.closed = true;
		link.closedByUser = byUser;
		const wasReady = link.ready;
		const err = link.fatal ?? (byUser ? new UnivocalError("disconnected", "Disconnected by the client.") : new UnivocalError("transport", "The connection to Univocal closed."));
		link.socket.removeAllListeners("data");
		link.socket.destroy();
		const hs = link.handshake;
		link.handshake = undefined;
		if (hs?.timer) clearTimeout(hs.timer);
		const pending = [...link.pending.values()];
		link.pending.clear();
		for (const p of pending) p.reject(err);
		const sessions = [...link.sessions.values()];
		link.sessions.clear();
		for (const s of sessions) {
			if (byUser) {
				s.deliver("ended", { reason: "stopped" });
			} else {
				s.deliver("error", { code: err.code === "unauthorized" ? "unauthorized" : "disconnected", message: err.message, fatal: true, sessionId: s.id });
				s.deliver("ended", { reason: err.code === "unauthorized" && err.reason === "revoked" ? "revoked" : "error" });
			}
		}
		link.hotkey.clear();
		const current = this.link === link;
		if (current) this.link = undefined;
		hs?.reject(err);
		if (current && wasReady && !byUser) {
			this.setState({ kind: "disconnected", error: err.connectError });
			this.log.info(`[univocal] connection closed code=${err.code}`);
			if (!["consentDenied", "unauthorized", "unsupportedVersion"].includes(err.code)) this.scheduleReconnect();
		}
	}

	private setState(next: ConnectionState): void {
		const prev = this._state;
		if (prev.kind === next.kind && prev.kind !== "connected" && JSON.stringify(prev) === JSON.stringify(next)) return;
		this._state = next;
		this.events.emit("connection", next);
	}

	// -----------------------------------------------------------------------
	// Tokens
	// -----------------------------------------------------------------------

	/**
	 * Token-store account. `hello` precedes `welcome`, so the key must be known
	 * before the handshake: the discovery file's `server.bundleId` (equal to
	 * `welcome.server.bundleId` for Univocal itself), plus `@<connectDir>` for a
	 * non-default dir so a mock never shares or deletes the real token.
	 */
	tokenKey(serverBundleId?: string): string {
		return tokenAccount(serverBundleId || (this.options.appBundleId ?? DEFAULT_APP_BUNDLE_ID), this.connectDir);
	}

	private get tokenTimeoutMs(): number {
		// A backstop over the store's own timeout (the Keychain store caps each `security` call at 1.5 s).
		return this.options.tokenTimeoutMs ?? DEFAULT_TOKEN_TIMEOUT_MS + 500;
	}

	/** Never rejects: resolves `null` on timeout or error so the hello goes out without a token. */
	private async readToken(serverBundleId: string): Promise<string | null> {
		try {
			const t = await withTimeout(Promise.resolve().then(() => this.options.tokenStore.get(serverBundleId)), this.tokenTimeoutMs, "read");
			return typeof t === "string" && t !== "" ? t : null;
		} catch (e) {
			this.log.warn(`[univocal] token read failed; connecting without a token (${(e as Error)?.message ?? e})`);
			return null;
		}
	}

	private tokenOp(op: string, fn: () => Promise<void>): Promise<void> {
		const p = withTimeout(Promise.resolve().then(fn), this.tokenTimeoutMs, op).catch((e: unknown) => {
			this.log.warn(`[univocal] token ${op} failed (${(e as Error)?.message ?? e})`);
		});
		this.tokenWrites.add(p);
		void p.finally(() => this.tokenWrites.delete(p));
		return p;
	}

	// -----------------------------------------------------------------------
	// Connection health: quiet reconnect with backoff, dir watch + poll
	// -----------------------------------------------------------------------

	private async quietAttempt(): Promise<QuietOutcome> {
		if (this.link?.ready) return "connected";
		if (Date.now() < this.revokedUntil) return "revoked";
		const d = readLiveDiscovery(this.connectDir);
		if (!d) return "noServer";
		this.lastSeenPid = d.pid;
		if (!this.inflight) {
			const token = await this.readToken(this.tokenKey(d.server.bundleId));
			if (!token) return "noToken";
		}
		try {
			await this.connect({ quiet: true });
			return "connected";
		} catch (e) {
			const code = e instanceof UnivocalError ? e.code : "transport";
			if (code === "consentDenied") return "denied";
			if (code === "unauthorized") return "revoked";
			if (code === "notRunning" || code === "notInstalled") return "noServer";
			return "failed";
		}
	}

	private scheduleReconnect(delayOverride?: number): void {
		if (!this.autoReconnect || this.reconnectTimer || this.link || this.inflight) return;
		const delays = this.options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
		let delay = delayOverride;
		if (delay === undefined) {
			if (this.reconnectAttempt >= delays.length) {
				this.log.debug("[univocal] reconnect: giving up until the server is seen launching again");
				return;
			}
			delay = delays[this.reconnectAttempt++] ?? 1000;
		}
		const gen = this.generation;
		this.reconnectTimer = unref(
			setTimeout(() => {
				this.reconnectTimer = undefined;
				if (gen !== this.generation || !this.autoReconnect) return;
				void this.quietAttempt().then((o) => {
					if (o === "failed" || o === "noServer") this.scheduleReconnect();
				});
			}, delay),
		);
	}

	private clearReconnectTimer(): void {
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = undefined;
	}

	private startWatching(): void {
		if (this.pollTimer) return;
		const dir = this.connectDir;
		this.pollTimer = unref(setInterval(() => this.checkServerAppearance(), this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS));
		try {
			const w = fs.watch(dir, { persistent: false }, () => {
				if (this.watchDebounce) clearTimeout(this.watchDebounce);
				this.watchDebounce = unref(setTimeout(() => this.checkServerAppearance(), 100));
			});
			w.on("error", () => {
				w.close();
				if (this.watcher === w) this.watcher = undefined;
			});
			this.watcher = w;
		} catch {
			// The dir may not exist yet (Univocal never ran); the poll covers it.
		}
	}

	private stopWatching(): void {
		if (this.pollTimer) clearInterval(this.pollTimer);
		this.pollTimer = undefined;
		if (this.watchDebounce) clearTimeout(this.watchDebounce);
		this.watchDebounce = undefined;
		this.watcher?.close();
		this.watcher = undefined;
	}

	/** A new live server pid (or the dir appearing) restarts the reconnect backoff. */
	private checkServerAppearance(): void {
		if (!this.watcher && this.pollTimer) {
			// Re-arm the watcher once the dir exists.
			const poll = this.pollTimer;
			this.pollTimer = undefined;
			clearInterval(poll);
			this.startWatching();
		}
		const d = readLiveDiscovery(this.connectDir);
		const pid = d?.pid ?? null;
		if (pid === null) {
			this.lastSeenPid = null;
			return;
		}
		if (pid === this.lastSeenPid || this.link || this.inflight || !this.autoReconnect) return;
		this.lastSeenPid = pid;
		this.reconnectAttempt = 0;
		this.clearReconnectTimer();
		this.log.debug(`[univocal] server appeared pid=${pid}`);
		this.scheduleReconnect(150);
	}

	// -----------------------------------------------------------------------
	// Install / launch
	// -----------------------------------------------------------------------

	private isInstalled(): Promise<boolean> {
		const bundleId = this.options.appBundleId ?? DEFAULT_APP_BUNDLE_ID;
		return (this.options.isInstalled ?? defaultIsInstalled)(bundleId).catch(() => false);
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function connectSocket(path: string): Promise<net.Socket> {
	return new Promise((resolve, reject) => {
		const socket = net.connect({ path });
		const onError = (e: Error) => {
			socket.destroy();
			reject(e);
		};
		socket.once("error", onError);
		socket.once("connect", () => {
			socket.off("error", onError);
			resolve(socket);
		});
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => unref(setTimeout(r, ms)));
}

function cancelled(): UnivocalError {
	return new UnivocalError("transport", "Connecting was cancelled.");
}

function str(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

function num(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function obj(v: unknown): Record<string, unknown> {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function denialMessage(reason: ConsentDeniedReason): string {
	switch (reason) {
		case "timeout":
			return "Nobody answered the approval prompt in Univocal.";
		case "disabled":
			return "Univocal is set not to allow other apps.";
		case "rateLimited":
			return "Too many approval requests; try again in a minute.";
		case "quiet":
			return "Univocal no longer recognises this app's approval.";
		default:
			return "Univocal did not allow this app.";
	}
}

function execFileOk(file: string, args: string[], timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(file, args, { timeout: timeoutMs, encoding: "utf8" }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
	});
}

/** `open -g -b <id> --args --connect` (SPEC §4.3). Only ever called from `connect({launch:true})`. */
export async function defaultLauncher(appBundleId: string): Promise<void> {
	await execFileOk("/usr/bin/open", ["-g", "-b", appBundleId, "--args", "--connect"], 5000);
}

/** `/Applications/Univocal.app` fast path, else `mdfind` by bundle id (1.5 s cap). */
export async function defaultIsInstalled(appBundleId: string): Promise<boolean> {
	if (process.platform !== "darwin") return false;
	const app = appBundleId.endsWith(".dev") ? "/Applications/Univocal Dev.app" : "/Applications/Univocal.app";
	if (fs.existsSync(app)) return true;
	if (!/^[A-Za-z0-9.-]+$/.test(appBundleId)) return false;
	try {
		const out = await execFileOk("/usr/bin/mdfind", [`kMDItemCFBundleIdentifier == '${appBundleId}'`], 1500);
		return out.trim() !== "";
	} catch {
		return false;
	}
}
