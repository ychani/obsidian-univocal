/**
 * Shared protocol and API types for @univocal/connect (SPEC v1, Draft 2).
 * Self-contained: imports nothing outside `src/connect/`.
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
	/**
	 * Which instance of the app this connection is (an Obsidian vault name, a
	 * workspace…), sent as `hello.client.instance`. A server can add it to a
	 * wake URL it opens on the user's request (SPEC §16.5). At most 128 chars.
	 */
	instance?: string;
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
 * Where the grant token lives. Keyed by the server's `bundleId`.
 *
 * Default implementation: {@link createDefaultTokenStore} — macOS `security`
 * CLI (service `com.univocal.connect`, account = server bundleId), falling back
 * to a 0600 file under `~/Library/Application Support/obsidian-univocal/`,
 * NEVER inside the vault. `get` resolves `null` when absent; implementations
 * must not throw for "not found". The client additionally wraps every call in
 * a short timeout so a slow store can never stall the hello.
 */
export interface TokenStore {
	get(serverBundleId: string): Promise<string | null>;
	set(serverBundleId: string, token: string): Promise<void>;
	delete(serverBundleId: string): Promise<void>;
}

/** Constructor options for `UnivocalClient`. */
export interface ConnectOptions {
	/**
	 * Connect directory override. Resolution order: this value, then
	 * `process.env.UNIVOCAL_CONNECT_DIR`, then the default
	 * `~/Library/Application Support/Univocal/Connect`. See `resolveConnectDir`.
	 */
	connectDir?: string;
	clientInfo: ClientInfo;
	/** Announced in `hello.capabilities`; include `"hotkey-target"` to receive `readRequest`. */
	capabilities: ClientCapability[];
	tokenStore: TokenStore;
	logger?: Logger;
	/** Bundle id used to launch (`open -g -b <id> --args --connect`). Default `com.univocal.app`. */
	appBundleId?: string;

	// --- Extensions (all optional; defaults are the production behaviour) ---

	/** Timeout for each token-store call (ms). Default 1500. On timeout the client proceeds without a token. */
	tokenTimeoutMs?: number;
	/** How long `connect({launch:true})` waits for the discovery file (ms). Default 10000. */
	launchTimeoutMs?: number;
	/** Auto-reconnect backoff (ms). Default `[1000, 2000, 4000]`; then wait for the next server launch. */
	reconnectDelaysMs?: number[];
	/** Discovery poll interval while watching for the server (ms). Default 5000. */
	pollIntervalMs?: number;
	/** Is Univocal installed? Default: `/Applications/Univocal.app` or `mdfind` (1.5 s cap). */
	isInstalled?: (appBundleId: string) => Promise<boolean>;
	/** Launches Univocal. Default `open -g -b <appBundleId> --args --connect`. */
	launcher?: (appBundleId: string) => Promise<void>;
}

/** Per-call options for `UnivocalClient.connect`. */
export interface ConnectCallOptions {
	/** Launch Univocal if `connect.json` is missing or stale. Never true for hotkey purposes. */
	launch?: boolean;
	/** Send `hello{quiet:true}`: connect only if already authorised; never prompts. */
	quiet?: boolean;
	/** Handshake timeout before any consent message (ms). Default 10000. */
	timeoutMs?: number;
	/** The `requestId` from a wake URL (SPEC §16.5), sent as `hello.wakeRequestId`. */
	wakeRequestId?: string;
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
	/**
	 * Extension: more text follows via `client.append(session, text, more)`
	 * (virtualised reading view). The last chunk of this call is then sent with
	 * `more:true`. Default false.
	 */
	more?: boolean;
	/** Extension: explicit `sessionId` (default: a random UUID). */
	sessionId?: string;
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
	/**
	 * Extension: monotonically increasing per client. A newer session always
	 * has a larger token; events of an older session are dropped once a newer
	 * one starts (the older one gets a local `ended{preempted}` first).
	 * Optional in the interface so test doubles stay valid; always set by the client.
	 */
	readonly token?: number;
	/** Extension: last reported playback state (`"ended"` once terminal). Always set by the client. */
	readonly state?: SessionState | "ended";
	/** Extension: UTF-16 length of all text sent so far (read + appends). Always set by the client. */
	readonly textLength?: number;
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

/** `voices` entry (SPEC §5.10). */
export interface Voice {
	id: string;
	name: string;
	lang?: string;
}
