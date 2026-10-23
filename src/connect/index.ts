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
 * - The token store read must never block the handshake: callers wrap it in a
 *   short timeout and connect without a token on failure.
 * - One client per plugin instance. Unknown message `type`s are ignored.
 *   Server `ping` → `pong`.
 */

// ---------------------------------------------------------------------------
// Shared protocol types
// ---------------------------------------------------------------------------

/** `hello.client` (SPEC §5.1). `id` is reverse-DNS; grants are keyed on it. */
export interface ClientInfo {
	id: string;
	name: string;
	version: string;
	bundleId?: string;
}

/** `welcome.server` (SPEC §5.2). */
export interface ServerInfo {
	name: string;
	version: string;
	bundleId: string;
}

/** `welcome.limits` (SPEC §5.2). */
export interface Limits {
	maxFrameBytes: number;
	/** Total UTF-8 size of one session's text across all chunks. */
	maxTextBytes: number;
	rate: { min: number; max: number };
}

/** Contents of `<connectDir>/connect.json` (SPEC §4.2). */
export interface Discovery {
	protocol: string;
	versions: number[];
	socket: string;
	ws?: { url: string };
	pid: number;
	server: ServerInfo;
}

/** Client capability strings announced in `hello` (SPEC §11). */
export type ClientCapability = "word-events" | "sentence-events" | "hotkey-target" | (string & {});

export interface Logger {
	debug(msg: string, ...args: unknown[]): void;
	info(msg: string, ...args: unknown[]): void;
	warn(msg: string, ...args: unknown[]): void;
	error(msg: string, ...args: unknown[]): void;
}

/**
 * Where the grant token lives. Keyed by the server's `welcome.server.bundleId`.
 *
 * Default implementation (plan §1): macOS `security` CLI via `execFile`,
 * service `com.univocal.connect`, account = server bundleId, `-U` to update,
 * `-w` to read. Fallback: a 0600 file under
 * `~/Library/Application Support/obsidian-univocal/` — NEVER inside the vault.
 * `get` resolves `null` when absent; implementations must not throw for
 * "not found" and must time out quickly rather than stall the hello.
 */
export interface TokenStore {
	get(serverBundleId: string): Promise<string | null>;
	set(serverBundleId: string, token: string): Promise<void>;
	delete(serverBundleId: string): Promise<void>;
}

/** Constructor options for {@link UnivocalClient}. */
export interface ConnectOptions {
	/**
	 * Connect directory override. Resolution order (plan §1): this value, then
	 * `process.env.UNIVOCAL_CONNECT_DIR`, then the default
	 * `~/Library/Application Support/Univocal/Connect`. See {@link resolveConnectDir}.
	 */
	connectDir?: string;
	clientInfo: ClientInfo;
	/** Announced in `hello.capabilities`; include `"hotkey-target"` to receive `readRequest`. */
	capabilities: ClientCapability[];
	tokenStore: TokenStore;
	logger?: Logger;
	/** Bundle id used by `launch()` (`open -g -b <id> --args --connect`). Default `com.univocal.app`. */
	appBundleId?: string;
}

/** Per-call options for {@link UnivocalClient.connect}. */
export interface ConnectCallOptions {
	/** Launch Univocal if `connect.json` is missing or stale. Never true for hotkey purposes. */
	launch?: boolean;
	/** Send `hello{quiet:true}`: connect only if already authorised; never prompts. */
	quiet?: boolean;
	timeoutMs?: number;
}

export type ConnectError =
	| { code: "notInstalled" }
	| { code: "notRunning" }
	| { code: "consentDenied"; reason: ConsentDeniedReason }
	| { code: "unauthorized"; reason?: string }
	| { code: "unsupportedVersion" }
	| { code: "protocolError" | "timeout" | "transport"; message: string };

export type ConnectionState =
	| { kind: "disconnected"; error?: ConnectError }
	| { kind: "launching" }
	| { kind: "connecting" }
	| { kind: "awaitingConsent" }
	| { kind: "connected"; server: ServerInfo; capabilities: string[]; limits: Limits };

export type ConsentDeniedReason = "user" | "timeout" | "disabled" | "rateLimited" | "quiet";

/** Consent flow (SPEC §5.3), surfaced so the UI can show "Waiting for approval in Univocal…". */
export type ConsentEvent =
	| { kind: "pending"; requestId: string; timeoutSeconds: number }
	| { kind: "granted"; requestId: string }
	| { kind: "denied"; requestId: string; reason: ConsentDeniedReason };

/** `error` (S→C, SPEC §5.8). */
export interface ProtocolError {
	code: string;
	message: string;
	fatal: boolean;
	id?: string | number;
	sessionId?: string;
}

// ---------------------------------------------------------------------------
// Reading sessions
// ---------------------------------------------------------------------------

/** Options for `read` (SPEC §5.4). `text` is passed separately. */
export interface ReadOptions {
	/** Whole-document offset to begin at; the server starts at that sentence. */
	startOffset?: number;
	lang?: string;
	voice?: string | null;
	rate?: number;
	/** Default true. */
	preempt?: boolean;
	title?: string;
	/** Answers a `readRequest` (SPEC §5.11). Set by the client when answering via a handler. */
	requestId?: string;
}

export type SessionState = "loading" | "playing" | "paused";
export type EndedReason = "finished" | "stopped" | "preempted" | "error" | "revoked";

/** Half-open `[start, end)` UTF-16 offsets into the session text. */
export interface OffsetRange {
	start: number;
	end: number;
}

export interface ReadingSessionEvents {
	/** Emitted before the sentence's first `word`. */
	sentence: OffsetRange;
	/** May repeat an identical range; consumers should not re-animate an unchanged range. */
	word: OffsetRange;
	state: { state: SessionState; detail?: string };
	progress: { offset: number };
	rate: { rate: number };
	/** Last event for a session. `preempted` is a quiet stop, never an error toast. */
	ended: { reason: EndedReason; by?: string };
	error: ProtocolError;
}

export type Unsubscribe = () => void;

/** One live session. Events are routed by `sessionId`; `ended` makes it terminal. */
export interface ReadingSession {
	readonly id: string;
	readonly ended: boolean;
	on<K extends keyof ReadingSessionEvents>(event: K, listener: (payload: ReadingSessionEvents[K]) => void): Unsubscribe;
	pause(): Promise<void>;
	resume(): Promise<void>;
	stop(): Promise<void>;
	seek(offset: number): Promise<void>;
	setRate(rate: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// Hotkey routing (SPEC §5.11, §16)
// ---------------------------------------------------------------------------

/** `readRequest` (S→C). Only sent to connections that announced `hotkey-target`. */
export interface ReadRequest {
	requestId: string;
	trigger: "hotkey";
	prefer: "selection" | "document";
	answerMs: number;
	acceptedMs: number;
}

export type ReadDeclineReason = "noContent" | "busy" | "notFocused" | "userDisabled" | "other";

/**
 * What a {@link ReadRequestHandler} returns. Exactly one answer per request.
 * - `read`: text already in hand → client sends `read{requestId}` directly.
 * - `accept`: client sends `readAccepted` immediately, then awaits `produce()`
 *   and sends `read{requestId}` (must arrive within `acceptedMs`). `produce()`
 *   resolving `null` sends `readDecline{noContent}` instead.
 * - `decline`: client sends `readDecline{reason, detail}`. `detail` is for
 *   logs and must never contain document text.
 * `error{unknownRequest}` on the answering read (too late) is cleared silently.
 */
export type ReadRequestAnswer =
	| { kind: "read"; text: string; options?: ReadOptions; onSession?: (s: ReadingSession) => void }
	| {
			kind: "accept";
			produce: () => Promise<{ text: string; options?: ReadOptions } | null>;
			onSession?: (s: ReadingSession) => void;
	  }
	| { kind: "decline"; reason: ReadDeclineReason; detail?: string };

/** Must answer synchronously (or within a few ms); the budget is `answerMs` ≥ 300. */
export type ReadRequestHandler = (req: ReadRequest) => ReadRequestAnswer;

export interface UnivocalClientEvents {
	connection: ConnectionState;
	consent: ConsentEvent;
	/** Connection-level (non-session) protocol errors. */
	error: ProtocolError;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const DEFAULT_APP_BUNDLE_ID = "com.univocal.app";

/** Resolve the connect dir: override, then `UNIVOCAL_CONNECT_DIR`, then the default. */
export function resolveConnectDir(override?: string): string {
	if (override) return override;
	const env = process.env.UNIVOCAL_CONNECT_DIR;
	if (env) return env;
	// TODO(A): `<home>/Library/Application Support/Univocal/Connect` (`Univocal Dev` for `.dev` bundle ids).
	return `${process.env.HOME ?? ""}/Library/Application Support/Univocal/Connect`;
}

function notImplemented(name: string): never {
	throw new Error(`@univocal/connect: ${name} is not implemented yet`);
}

export class UnivocalClient {
	readonly options: ConnectOptions;

	constructor(options: ConnectOptions) {
		this.options = { appBundleId: DEFAULT_APP_BUNDLE_ID, ...options };
	}

	get state(): ConnectionState {
		// TODO(A)
		return { kind: "disconnected" };
	}

	/** `notInstalled` / `installed` (not running) / `running` (live connect.json + pid). */
	availability(): Promise<"notInstalled" | "installed" | "running"> {
		return notImplemented("availability");
	}

	/**
	 * Read discovery → (optionally launch) → `net.connect` → `hello` (with stored
	 * token) → handle consent → resolves on `welcome`. On `consentGranted` store
	 * the token and do NOT re-send hello. On `consentDenied{quiet}` delete the
	 * token. Rejects with a {@link ConnectError}.
	 */
	connect(opts?: ConnectCallOptions): Promise<ServerInfo> {
		void opts;
		return notImplemented("connect");
	}

	/**
	 * Quiet connect for hotkey routing at layout-ready (plan §4): only when a
	 * token exists AND connect.json is live; sends `hello{quiet:true}`; never
	 * launches or prompts. Resolves `null` when there is no token, the server is
	 * not running, or the server answered `consentDenied{quiet}` (token deleted).
	 */
	connectQuietly(): Promise<ServerInfo | null> {
		return notImplemented("connectQuietly");
	}

	/** Change the connect dir live; reconnects if currently connected. */
	setConnectDir(dir: string | undefined): void {
		this.options.connectDir = dir;
		// TODO(A): reconnect.
	}

	/** Close the socket; the live session (if any) ends silently server-side. */
	disconnect(): void {
		// TODO(A)
	}

	/**
	 * Start a session (SPEC §5.4). Chunks text over 512 KiB UTF-8 at `\n\n`
	 * boundaries (`read{more:true}` + `append`), refuses text over
	 * `limits.maxTextBytes`. Resolves after `ok`.
	 */
	read(text: string, opts?: ReadOptions): Promise<ReadingSession> {
		void text;
		void opts;
		return notImplemented("read");
	}

	/**
	 * Append more text to a session opened with `more` (virtualised reading
	 * view, plan §2). `more:false` marks the final chunk.
	 */
	append(session: ReadingSession, text: string, more: boolean): Promise<void> {
		void session;
		void text;
		void more;
		return notImplemented("append");
	}

	/**
	 * Register the single `readRequest` handler (replaces any previous one).
	 * The client turns the returned answer into `read{requestId}` /
	 * `readAccepted` + `read` / `readDecline`. Returns an unregister function;
	 * with no handler registered the client declines `other`.
	 */
	onReadRequest(handler: ReadRequestHandler): Unsubscribe {
		void handler;
		// TODO(A)
		return () => {};
	}

	on<K extends keyof UnivocalClientEvents>(event: K, listener: (payload: UnivocalClientEvents[K]) => void): Unsubscribe {
		void event;
		void listener;
		// TODO(A)
		return () => {};
	}
}
