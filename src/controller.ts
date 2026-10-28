import * as nodeTimers from "node:timers";
/**
 * Read-aloud controller (plan §3–§5), modelled on PreviewMD's
 * ReadAloudController. Obsidian-free on purpose: it talks to Obsidian through
 * {@link NoteHost} / {@link NoteRef} (implemented in `main.ts`) and to
 * Univocal through {@link ConnectPort} (a structural subset of
 * `UnivocalClient`), so the state machine can be unit-tested with fakes.
 *
 * Highlight invariants (plan §3): one live word range and one live sentence
 * range; every session start clears first; a monotonically increasing session
 * token drops late events; `clear()` runs on `ended`, active-leaf-change,
 * file-open, layout-change and re-render.
 */
import type {
	ConnectionState,
	ConsentEvent,
	EndedReason,
	OffsetRange,
	ProtocolError,
	ReadOptions,
	ReadRequest,
	ReadRequestAnswer,
	ReadingSession,
	ServerInfo,
	TokenStore,
	UnivocalClient,
	Unsubscribe,
} from "./connect/index";
import type { Highlighter } from "./highlight/types";
import type { TextMap } from "./textmap/types";

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

export type ReaderState =
	| { kind: "idle" }
	| { kind: "connecting"; detail?: string }
	| { kind: "consentPending" }
	| { kind: "loading"; detail?: string }
	| { kind: "playing" }
	| { kind: "paused" }
	| { kind: "failed"; message: string }
	| { kind: "notInstalled" }
	| { kind: "notRunning" }
	| { kind: "denied"; message: string };

export type ReaderStateKind = ReaderState["kind"];

/** Which surface a session reads: reading view, or the CM6 editor (Live Preview / source). */
export type SurfaceMode = "reading" | "live-preview" | "source";

export type StartPreference = "selection" | "document";

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** The parts of `UnivocalClient` the controller uses. `UnivocalClient` satisfies it as-is. */
export type ConnectPort = Pick<
	UnivocalClient,
	| "state"
	| "availability"
	| "connect"
	| "connectQuietly"
	| "read"
	| "append"
	| "onReadRequest"
	| "on"
	| "disconnect"
	| "setConnectDir"
>;

/**
 * `read` options plus `more` (SPEC §5.4/§8) for a reading view that is still
 * virtualised. INTEGRATION SEAM: the stub's `ReadOptions` has no `more`;
 * client A must forward it (or chunk on its own and ignore it).
 */
export type ReadOptionsWithMore = ReadOptions & { more?: boolean };

/** Painted-range counts, for QA assertions through the dev status file. */
export interface PaintedCount {
	word: number;
	sentence: number;
}

/**
 * One prepared reading surface: the text sent to Univocal plus the way to paint
 * session offsets on screen. Built by {@link createMappedSurface} from a
 * text map + highlighter; the highlighter is created lazily on first paint so
 * an old surface can always be disposed before a new one registers.
 */
export interface Surface {
	readonly mode: SurfaceMode;
	readonly text: string;
	/** False while a virtualised reading view has unrendered sections. */
	readonly complete: boolean;
	/** Offset of the selection start, or `null` without a selection. */
	selectionOffset(): number | null;
	/** Offset of the first visible block (never before the body start). */
	firstVisibleOffset(): number;
	setWord(range: OffsetRange | null): void;
	setSentence(range: OffsetRange | null): void;
	clear(): void;
	painted(): PaintedCount;
	dispose(): void;
}

export interface MappedSurfaceParts<R> {
	mode: SurfaceMode;
	map: TextMap<R>;
	/** Created on first paint. */
	highlighter: () => Highlighter<R>;
	selectionOffset: () => number | null;
	firstVisibleOffset: () => number;
	complete?: () => boolean;
	/** Count of the ranges actually painted (e.g. `CSS.highlights` sizes); default counts what was set. */
	countPainted?: (highlighter: Highlighter<R> | null) => PaintedCount | null;
	/** How many on-screen ranges one mapped value is (e.g. `Range[]` length); default 1. */
	sizeOf?: (mapped: R) => number;
}

/** Wraps a text map and a highlighter into a {@link Surface}. */
export function createMappedSurface<R>(parts: MappedSurfaceParts<R>): Surface {
	let hl: Highlighter<R> | null = null;
	let disposed = false;
	let wordCount = 0;
	let sentenceCount = 0;
	const sizeOf = parts.sizeOf ?? (() => 1);
	const highlighter = (): Highlighter<R> | null => {
		if (disposed) return null;
		if (!hl) hl = parts.highlighter();
		return hl;
	};
	return {
		mode: parts.mode,
		text: parts.map.text,
		get complete() {
			return parts.complete ? parts.complete() : true;
		},
		selectionOffset: parts.selectionOffset,
		firstVisibleOffset: parts.firstVisibleOffset,
		setWord(range) {
			const h = highlighter();
			if (!h) return;
			if (!range) {
				h.setWord(null);
				wordCount = 0;
				return;
			}
			const mapped = parts.map.rangeFor(range.start, range.end);
			h.setWord(mapped);
			wordCount = sizeOf(mapped);
		},
		setSentence(range) {
			const h = highlighter();
			if (!h) return;
			if (!range) {
				h.setSentence(null);
				sentenceCount = 0;
				return;
			}
			const mapped = parts.map.rangeFor(range.start, range.end);
			h.setSentence(mapped);
			sentenceCount = sizeOf(mapped);
		},
		clear() {
			hl?.clear();
			wordCount = 0;
			sentenceCount = 0;
		},
		painted() {
			return parts.countPainted?.(hl) ?? { word: wordCount, sentence: sentenceCount };
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			hl?.dispose();
			hl = null;
			wordCount = 0;
			sentenceCount = 0;
		},
	};
}

export type NoteChange = "edited" | "rerendered";

/** The note in one MarkdownView, captured when reading starts. */
export interface NoteRef {
	/** Vault path of the file. */
	readonly path: string;
	readonly title: string;
	readonly mode: SurfaceMode;
	/** Nothing to read (blank after front matter). Cheap: no text map is built. */
	isEmpty(): boolean;
	/** False once the view shows another file, switched mode, or closed. */
	isAlive(): boolean;
	/** A fresh text map + (lazy) highlighter for the current content; `null` if not possible now. */
	createSurface(): Surface | null;
	/** `edited` = editor docChanged; `rerendered` = reading view DOM re-rendered. */
	onChange(listener: (change: NoteChange) => void): Unsubscribe;
}

export interface NoteHost {
	/** The active MarkdownView's note, or `null`. */
	activeNote(): NoteRef | null;
	/** `activeDocument.hasFocus()` — false when another window/app (or another vault) has focus. */
	windowHasFocus(): boolean;
}

export interface ControllerSettings {
	rate: number;
	hotkeyRouting: boolean;
}

export interface ControllerOptions {
	client: ConnectPort;
	host: NoteHost;
	settings: () => ControllerSettings;
	/** Bundle ids whose token "Forget authorization" deletes when no server was seen yet. */
	tokenStore: TokenStore;
	defaultServerBundleId?: string;
	/** User-visible message (Obsidian `Notice`). */
	notify?: (message: string) => void;
	log?: (message: string) => void;
	/** Debounce before restarting after an edit (ms). */
	editDebounceMs?: number;
	/** Reconnect backoff after a dropped connection (ms). */
	reconnectDelaysMs?: number[];
}

export interface DevStatus {
	state: ReaderStateKind;
	message: string | null;
	sessionId: string | null;
	lastWord: OffsetRange | null;
	lastSentence: OffsetRange | null;
	painted: PaintedCount;
	mode: SurfaceMode | null;
	note: string | null;
	connection: ConnectionState["kind"];
	server: ServerInfo | null;
	updatedAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(n: number, lo: number, hi: number): number {
	return n < lo ? lo : n > hi ? hi : n;
}

function snapToCodePoint(text: string, i: number): number {
	if (i > 0 && i < text.length) {
		const c = text.charCodeAt(i);
		const p = text.charCodeAt(i - 1);
		if (c >= 0xdc00 && c <= 0xdfff && p >= 0xd800 && p <= 0xdbff) return i - 1;
	}
	return i;
}

const TERMINAL = /[.!?…。！？]/;
const CLOSER = /["'”’)\]]/;
const SPACE = /[ \t\u00a0]/;

/** Start of the sentence containing `pos`, looking back at most `maxBack` units (port of read-aloud-core.js). */
export function sentenceStartBefore(text: string, pos: number, maxBack: number): number {
	pos = clamp(pos, 0, text.length);
	const limit = Math.max(0, pos - maxBack);
	for (let i = pos; i > limit; i--) {
		const ch = text.charAt(i - 1);
		if (ch === "\n") return i;
		if (SPACE.test(ch) && i >= 2) {
			let j = i - 2;
			if (j > 0 && CLOSER.test(text.charAt(j))) j--;
			if (TERMINAL.test(text.charAt(j))) return i;
		}
	}
	return limit === 0 ? 0 : pos;
}

/**
 * Where to resume after the text changed from `oldText` to `newText` while
 * reading at `cur`: unchanged prefix → same offset; unchanged suffix → shifted
 * by the length difference; otherwise the sentence around the first change.
 */
export function remapOffset(oldText: string, newText: string, cur: number): number {
	const oldLen = oldText.length;
	const newLen = newText.length;
	cur = clamp(Math.trunc(cur), 0, oldLen);
	const n = Math.min(oldLen, newLen);
	let p = 0;
	while (p < n && oldText.charCodeAt(p) === newText.charCodeAt(p)) p++;
	const max = n - p;
	let q = 0;
	while (q < max && oldText.charCodeAt(oldLen - 1 - q) === newText.charCodeAt(newLen - 1 - q)) q++;
	let r: number;
	if (cur < p) r = cur;
	else if (cur >= oldLen - q) r = cur + (newLen - oldLen);
	else r = sentenceStartBefore(newText, snapToCodePoint(newText, p), 300);
	return snapToCodePoint(newText, clamp(r, 0, newLen));
}

function isBlank(text: string): boolean {
	return !/\S/.test(text);
}

function sameRange(a: OffsetRange | null, b: OffsetRange | null): boolean {
	return a === b || (!!a && !!b && a.start === b.start && a.end === b.end);
}

/** Error-ish value → `{code, reason, message}` (ConnectError objects or Error subclasses). */
function describe(e: unknown): { code?: string; reason?: string; message?: string } {
	if (e && typeof e === "object") {
		const o = e as { code?: unknown; reason?: unknown; message?: unknown };
		return {
			code: typeof o.code === "string" ? o.code : undefined,
			reason: typeof o.reason === "string" ? o.reason : undefined,
			message: typeof o.message === "string" ? o.message : undefined,
		};
	}
	return { message: typeof e === "string" ? e : undefined };
}

export function consentMessage(reason: string | undefined): string {
	switch (reason) {
		case "timeout":
			return "No answer in Univocal. Try again to ask again.";
		case "disabled":
			return "Univocal doesn't allow other apps. Turn that on in Univocal's settings.";
		case "rateLimited":
			return "Too many requests. Wait a minute, then try again.";
		default:
			return "Univocal didn't allow Obsidian. Try again to ask again.";
	}
}

const REVOKED_MESSAGE = "Obsidian's access was removed in Univocal.";

export function sessionErrorMessage(error: ProtocolError | null | undefined): string {
	if (!error) return "Reading stopped unexpectedly";
	switch (error.code) {
		case "unsupportedVersion":
			return "Update Univocal to read aloud from Obsidian";
		case "textTooLarge":
		case "limitExceeded":
			return "This note is too long to read aloud";
		case "engineUnavailable":
			return error.message || "Univocal's voice isn't ready yet";
		case "engineError":
			return "Univocal couldn't read this note";
		default:
			return error.message || "Reading stopped unexpectedly";
	}
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

type Listener = (state: ReaderState) => void;

export class ReadAloudController {
	private _state: ReaderState = { kind: "idle" };
	private readonly listeners = new Set<Listener>();
	private readonly client: ConnectPort;
	private readonly host: NoteHost;
	private readonly opts: ControllerOptions;

	/** Bumped whenever a session (or an attempt) is abandoned; late work for an older token is dropped. */
	private token = 0;
	private session: ReadingSession | null = null;
	private surface: Surface | null = null;
	private note: NoteRef | null = null;
	/** The note's text changed while starting (before the session existed). */
	private noteDirty = false;
	/** The note was edited while paused: restart when Univocal reports playing again. */
	private pendingRestart = false;
	private openedWithMore = false;
	/** Exactly the text the live session was given (`read` + `append`s). */
	private sessionText: string | null = null;
	private word: OffsetRange | null = null;
	private sentence: OffsetRange | null = null;
	/** Highlights were cleared by a workspace event; the next word repaints the sentence too. */
	private needsRepaint = false;
	private lastError: ProtocolError | null = null;
	/** A hotkey answer is outstanding (its session has not arrived yet). */
	private hotkeyPending = false;
	private sessionUnsubs: Unsubscribe[] = [];
	private noteUnsub: Unsubscribe | null = null;
	private editTimer: ReturnType<typeof nodeTimers.setTimeout> | null = null;
	private hotkeyTimer: ReturnType<typeof nodeTimers.setTimeout> | null = null;

	private clientUnsubs: Unsubscribe[] = [];
	private server: ServerInfo | null = null;
	private wasConnected = false;
	private closing = false;
	private reconnectTimer: ReturnType<typeof nodeTimers.setTimeout> | null = null;
	private quietInFlight = false;
	private started = false;
	private disposed = false;

	constructor(options: ControllerOptions) {
		this.opts = options;
		this.client = options.client;
		this.host = options.host;
	}

	// ----- observation -----

	get state(): ReaderState {
		return this._state;
	}

	get sessionId(): string | null {
		return this.session?.id ?? null;
	}

	get lastServer(): ServerInfo | null {
		return this.server;
	}

	/** Mode of the surface being read (or about to be). */
	get mode(): SurfaceMode | null {
		return this.surface?.mode ?? this.note?.mode ?? null;
	}

	onChange(listener: Listener): Unsubscribe {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** A session is starting or running. */
	get isActive(): boolean {
		switch (this._state.kind) {
			case "connecting":
			case "consentPending":
			case "loading":
			case "playing":
			case "paused":
				return true;
			default:
				return this.session !== null || this.hotkeyPending;
		}
	}

	private get isStarting(): boolean {
		return this.session === null && this.note !== null;
	}

	devStatus(): DevStatus {
		const s = this._state;
		return {
			state: s.kind,
			message: s.kind === "failed" || s.kind === "denied" ? s.message : null,
			sessionId: this.sessionId,
			lastWord: this.word,
			lastSentence: this.sentence,
			painted: this.surface?.painted() ?? { word: 0, sentence: 0 },
			mode: this.mode,
			note: this.note?.path ?? null,
			connection: this.client.state.kind,
			server: this.server,
			updatedAt: new Date().toISOString(),
		};
	}

	private setState(next: ReaderState): void {
		const prev = this._state;
		if (
			prev.kind === next.kind &&
			JSON.stringify(prev) === JSON.stringify(next)
		) {
			return;
		}
		this._state = next;
		for (const l of [...this.listeners]) l(next);
	}

	private notify(message: string): void {
		this.opts.notify?.(message);
	}

	private log(message: string): void {
		this.opts.log?.(message);
	}

	// ----- lifecycle -----

	/**
	 * Start hotkey integration (call once on layout ready): register the
	 * `readRequest` handler, follow the connection, check availability and
	 * connect quietly if a token exists (plan §4). Never launches Univocal.
	 */
	start(): void {
		if (this.started || this.disposed) return;
		this.started = true;
		this.clientUnsubs.push(
			this.client.onReadRequest((req) => this.handleReadRequest(req)),
			this.client.on("connection", (st) => this.connectionChanged(st)),
			this.client.on("consent", (ev) => this.consentChanged(ev)),
		);
		void this.refreshAvailability().then(() => this.connectQuietly());
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.closing = true;
		const old = this.session;
		this.endSession();
		if (old) void old.stop().catch(() => {});
		this.cancelReconnect();
		for (const u of this.clientUnsubs) u();
		this.clientUnsubs = [];
		this.listeners.clear();
		this.client.disconnect();
	}

	// ----- user actions -----

	/** Read the active note from the selection, else the first visible block. */
	async read(opts: { prefer?: StartPreference } = {}): Promise<void> {
		if (this.disposed) return;
		const note = this.host.activeNote();
		if (!note) {
			this.notify("Open a note to read it aloud.");
			return;
		}
		if (note.isEmpty()) {
			this.notify("This note has nothing to read.");
			return;
		}
		const old = this.session;
		this.endSession();
		if (old) void old.stop().catch(() => {});
		const token = this.token;
		this.adoptNote(note, token);
		const surface = note.createSurface();
		if (!surface || isBlank(surface.text)) {
			surface?.dispose();
			this.endSession();
			this.setState({ kind: "idle" });
			this.notify(surface ? "This note has nothing to read." : "This note isn't ready to read yet.");
			return;
		}
		// Capture where to start now: the connect may wait on consent for a while.
		const start = this.startOffsetFor(surface, opts.prefer ?? "selection");
		this.surface = surface;
		this.setState({ kind: "connecting" });
		if (this.client.state.kind !== "connected") {
			try {
				const server = await this.client.connect({ launch: true });
				if (server) this.server = server;
			} catch (e) {
				if (token !== this.token) return;
				this.failConnect(e, true);
				return;
			}
			if (token !== this.token) return;
		}
		if (!note.isAlive()) {
			this.endSession();
			this.setState({ kind: "idle" });
			return;
		}
		let target = surface;
		let at = start;
		if (this.noteDirty) {
			// Edited while we were connecting: re-map the start onto the new text.
			surface.dispose();
			this.surface = null;
			const fresh = note.createSurface();
			if (!fresh || isBlank(fresh.text)) {
				fresh?.dispose();
				this.endSession();
				this.setState({ kind: "idle" });
				return;
			}
			at = remapOffset(surface.text, fresh.text, start);
			target = fresh;
			this.surface = fresh;
			this.noteDirty = false;
		}
		await this.beginRead(note, target, at, token);
	}

	/**
	 * The "Read aloud" command and the ribbon: start reading the active note.
	 * Does nothing while a reading is starting or running: Univocal's
	 * floating pill is the only in-session control (pause, skip, speed,
	 * voice, stop), and Univocal's ⌥⇧R toggles pause/resume. Its actions
	 * arrive as ordinary session events, which this controller follows.
	 */
	readAloud(): void {
		if (this.disposed || this.isActive) return;
		void this.read();
	}

	/**
	 * Developer-only (`obsidian://univocal-dev?cmd=pause`, for QA): pause or
	 * resume the session as if from Univocal's pill. Not a user control.
	 */
	async devPauseResume(): Promise<void> {
		const session = this.session;
		if (!session) return;
		if (this._state.kind === "paused") {
			// An edit while paused restarts on the resulting `state: playing`.
			await session.resume().catch((e) => this.log(`resume failed: ${describe(e).message ?? String(e)}`));
		} else {
			await session.pause().catch((e) => this.log(`pause failed: ${describe(e).message ?? String(e)}`));
		}
	}

	/**
	 * Stop reading (or the attempt to start) and clear the highlights. Not a
	 * user control while reading: a note switch, leaf change, unload, the
	 * status bar's cancel while connecting / awaiting approval, and Forget
	 * authorization end a reading this way.
	 */
	stop(): void {
		if (!this.isActive && !this.session && !this.note) return;
		const old = this.session;
		this.endSession();
		if (old) void old.stop().catch(() => {});
		this.setState({ kind: "idle" });
		void this.refreshAvailability();
	}

	/** Settings → "Ask again": a non-quiet connect, which shows Univocal's prompt. */
	async authorize(): Promise<void> {
		if (this.client.state.kind === "connected") return;
		const token = this.token;
		this.setState({ kind: "connecting" });
		try {
			const server = await this.client.connect({ launch: true });
			if (server) this.server = server;
			if (token === this.token && !this.session) this.setState({ kind: "idle" });
		} catch (e) {
			if (token !== this.token) return;
			this.failConnect(e, true);
		}
	}

	/**
	 * Univocal opened `obsidian://univocal-connect?requestId=…` (SPEC §16.5):
	 * connect now with `hello{wakeRequestId}`. Not quiet, so a first connect
	 * shows Univocal's consent prompt. Never launches Univocal and never opens
	 * or focuses anything. Already connected: nothing to do.
	 */
	async wake(requestId: string): Promise<void> {
		if (this.disposed || this.client.state.kind === "connected") return;
		const token = this.token;
		this.setState({ kind: "connecting" });
		try {
			const server = await this.client.connect({ launch: false, wakeRequestId: requestId });
			if (server) this.server = server;
			if (token === this.token && !this.session) this.setState({ kind: "idle" });
		} catch (e) {
			if (token !== this.token) return;
			this.failConnect(e, false);
		}
	}

	/** Settings → "Forget authorization": disconnect and delete the stored token. */
	async forgetAuthorization(): Promise<void> {
		this.stop();
		this.closing = true;
		this.cancelReconnect();
		this.client.disconnect();
		const ids = new Set<string>();
		if (this.server?.bundleId) ids.add(this.server.bundleId);
		if (this.opts.defaultServerBundleId) ids.add(this.opts.defaultServerBundleId);
		for (const id of ids) {
			await this.opts.tokenStore.delete(id).catch((e) => this.log(`token delete failed: ${describe(e).message ?? String(e)}`));
		}
		this.closing = false;
		this.setState({ kind: "idle" });
		void this.refreshAvailability();
	}

	/** The rate setting changed. */
	rateChanged(rate: number): void {
		if (this.session && !this.session.ended) void this.session.setRate(rate).catch(() => {});
	}

	/** The connect dir setting changed: point the client there and reconnect. */
	connectDirChanged(dir: string | undefined): void {
		this.client.setConnectDir(dir);
		void this.serverAppeared();
	}

	// ----- host events -----

	/**
	 * active-leaf-change / file-open / layout-change: clear the highlights
	 * (the next word repaints them); stop if the note being read switched
	 * file, changed mode or closed.
	 */
	workspaceChanged(): void {
		if (!this.note) return;
		this.surface?.clear();
		this.needsRepaint = true;
		if (!this.note.isAlive()) this.stop();
	}

	/** `connect.json` appeared or changed (discovery watcher): re-check and connect quietly. */
	async serverAppeared(): Promise<void> {
		await this.refreshAvailability();
		await this.connectQuietly();
	}

	/** `connect.json` disappeared. */
	serverGone(): void {
		void this.refreshAvailability();
	}

	// ----- hotkey routing (plan §4, SPEC §5.11/§16) -----

	/** Answers Univocal's `readRequest` synchronously. */
	handleReadRequest(req: ReadRequest): ReadRequestAnswer {
		const note = this.host.activeNote();
		if (!note || !this.host.windowHasFocus()) {
			return { kind: "decline", reason: "notFocused" };
		}
		if (!this.opts.settings().hotkeyRouting) {
			return { kind: "decline", reason: "userDisabled" };
		}
		if (note.isEmpty()) {
			return { kind: "decline", reason: "noContent" };
		}
		// A reading the user started here is still connecting / waiting for approval.
		if (this.isStarting && !this.hotkeyPending) {
			return { kind: "decline", reason: "busy", detail: "starting" };
		}
		// Any session of ours was preempted by the hotkey already (its `ended` follows).
		const old = this.session;
		this.endSession();
		if (old) void old.stop().catch(() => {});
		const token = this.token;
		this.adoptNote(note, token);
		this.hotkeyPending = true;
		this.setState({ kind: "loading" });
		this.hotkeyTimer = nodeTimers.setTimeout(() => {
			// The read never became a session (too late → `unknownRequest`, cleared by the client).
			if (token === this.token && this.hotkeyPending && !this.session) {
				this.endSession();
				this.setState({ kind: "idle" });
			}
		}, req.acceptedMs + 2000);
		const onSession = (s: ReadingSession): void => {
			if (token !== this.token) {
				void s.stop().catch(() => {});
				return;
			}
			this.hotkeyPending = false;
			this.attach(s, token);
		};
		const prepare = (): { text: string; options: ReadOptionsWithMore } | null => {
			if (token !== this.token) return null;
			const surface = note.createSurface();
			if (!surface || isBlank(surface.text)) {
				surface?.dispose();
				this.endSession();
				this.setState({ kind: "idle" });
				return null;
			}
			this.surface = surface;
			this.sessionText = surface.text;
			return { text: surface.text, options: this.readOptions(note, surface, this.startOffsetFor(surface, req.prefer)) };
		};
		if (note.mode === "reading") {
			// Rendered-DOM extraction: buy time with `readAccepted` first.
			return {
				kind: "accept",
				produce: async () => prepare(),
				onSession,
			};
		}
		const ready = prepare();
		if (!ready) return { kind: "decline", reason: "noContent" };
		return { kind: "read", text: ready.text, options: ready.options, onSession };
	}

	// ----- sessions -----

	private adoptNote(note: NoteRef, token: number): void {
		this.note = note;
		this.noteDirty = false;
		this.noteUnsub = note.onChange((change) => {
			if (token !== this.token) return;
			this.noteChanged(change);
		});
	}

	private startOffsetFor(surface: Surface, prefer: StartPreference): number {
		const len = surface.text.length;
		if (prefer === "selection") {
			const sel = surface.selectionOffset();
			if (sel !== null) return clamp(sel, 0, len);
		}
		return clamp(surface.firstVisibleOffset(), 0, len);
	}

	private readOptions(note: NoteRef, surface: Surface, startOffset: number): ReadOptionsWithMore {
		const options: ReadOptionsWithMore = {
			startOffset,
			rate: this.opts.settings().rate,
			title: note.title,
		};
		if (!surface.complete) options.more = true;
		return options;
	}

	private async beginRead(note: NoteRef, surface: Surface, startOffset: number, token: number): Promise<void> {
		this.surface = surface;
		this.sessionText = surface.text;
		this.setState({ kind: "loading" });
		const options = this.readOptions(note, surface, startOffset);
		let session: ReadingSession;
		try {
			session = await this.client.read(surface.text, options);
		} catch (e) {
			if (token !== this.token) return;
			this.failConnect(e, true);
			return;
		}
		if (token !== this.token) {
			void session.stop().catch(() => {});
			return;
		}
		this.attach(session, token);
	}

	private attach(session: ReadingSession, token: number): void {
		this.session = session;
		this.openedWithMore = !(this.surface?.complete ?? true);
		const guard =
			<T>(fn: (payload: T) => void) =>
			(payload: T): void => {
				if (token === this.token) fn(payload);
			};
		this.sessionUnsubs.push(
			session.on(
				"state",
				guard(({ state, detail }) => {
					if (state === "loading") this.setState(detail ? { kind: "loading", detail } : { kind: "loading" });
					else if (state === "playing") {
						if (this.pendingRestart && this.note && this.surface) {
							// Univocal resumed after an edit: read the edited text.
							this.restartFromCurrent();
							return;
						}
						this.setState({ kind: "playing" });
					}
					else this.setState({ kind: "paused" });
				}),
			),
			session.on(
				"sentence",
				guard((range) => {
					this.sentence = range;
					this.word = null;
					this.needsRepaint = false;
					this.surface?.setWord(null);
					this.surface?.setSentence(range);
				}),
			),
			session.on(
				"word",
				guard((range) => {
					if (this.needsRepaint) {
						this.needsRepaint = false;
						this.surface?.setSentence(this.sentence);
					} else if (sameRange(this.word, range)) {
						return;
					}
					this.word = range;
					this.surface?.setWord(range);
				}),
			),
			session.on(
				"error",
				guard((err) => {
					this.lastError = err;
				}),
			),
			session.on(
				"ended",
				guard(({ reason }) => this.finish(reason)),
			),
		);
		if (this._state.kind === "connecting" || this._state.kind === "consentPending") {
			this.setState({ kind: "loading" });
		}
	}

	private finish(reason: EndedReason): void {
		const error = this.lastError;
		this.endSession();
		switch (reason) {
			case "finished":
			case "stopped":
			case "preempted":
				// Preempted: Univocal (or another app) started reading — quiet.
				this.setState({ kind: "idle" });
				void this.refreshAvailability();
				return;
			case "revoked":
				this.setState({ kind: "denied", message: REVOKED_MESSAGE });
				this.notify(REVOKED_MESSAGE);
				return;
			case "error": {
				if (error?.code === "unauthorized") {
					this.setState({ kind: "denied", message: REVOKED_MESSAGE });
					this.notify(REVOKED_MESSAGE);
				} else {
					const message = sessionErrorMessage(error);
					this.setState({ kind: "failed", message });
					this.notify(message);
				}
			}
		}
	}

	private noteChanged(change: NoteChange): void {
		if (!this.note) return;
		if (!this.session) {
			// Starting: re-map the start once connected.
			this.noteDirty = true;
			return;
		}
		if (change === "rerendered") {
			this.rerendered();
			return;
		}
		// Edited: offsets no longer match. Drop highlights; restart from the
		// re-mapped sentence (when Univocal resumes if paused, else after a debounce).
		this.surface?.clear();
		this.needsRepaint = true;
		if (this._state.kind === "paused") {
			this.pendingRestart = true;
			return;
		}
		if (this.editTimer) nodeTimers.clearTimeout(this.editTimer);
		const token = this.token;
		this.editTimer = nodeTimers.setTimeout(() => {
			this.editTimer = null;
			if (token === this.token) this.restartFromCurrent();
		}, this.opts.editDebounceMs ?? 300);
	}

	/** Reading view re-rendered: rebuild the map; same text → swap; grown → append; else restart. */
	private rerendered(): void {
		const note = this.note;
		const old = this.surface;
		if (!note || !old || !this.session) return;
		old.clear();
		this.needsRepaint = true;
		if (!note.isAlive()) {
			this.stop();
			return;
		}
		// Dispose before building: the new highlighter re-registers the same names.
		old.dispose();
		const fresh = note.createSurface();
		if (!fresh) {
			this.surface = null;
			return;
		}
		const sent = this.sessionText ?? old.text;
		this.surface = fresh;
		if (fresh.text === sent) {
			this.repaint();
			return;
		}
		if (this.openedWithMore && fresh.text.startsWith(sent)) {
			// A virtualised note rendered more sections: send them along.
			const delta = fresh.text.slice(sent.length);
			const more = !fresh.complete;
			this.openedWithMore = more;
			this.sessionText = fresh.text;
			void this.client.append(this.session, delta, more).catch((e) => this.log(`append failed: ${describe(e).message ?? String(e)}`));
			this.repaint();
			return;
		}
		if (this._state.kind === "paused") {
			this.pendingRestart = true;
			return;
		}
		this.restartWith(sent, fresh);
	}

	private repaint(): void {
		this.needsRepaint = false;
		this.surface?.setSentence(this.sentence);
		this.surface?.setWord(this.word);
	}

	/** Restart the session on the note's current text from the re-mapped current sentence. */
	private restartFromCurrent(): void {
		const note = this.note;
		const old = this.surface;
		if (!note || !old) return;
		if (!note.isAlive()) {
			this.stop();
			return;
		}
		const sent = this.sessionText ?? old.text;
		old.dispose();
		this.surface = null;
		const fresh = note.createSurface();
		if (!fresh) {
			this.stop();
			return;
		}
		this.restartWith(sent, fresh);
	}

	private restartWith(oldText: string, fresh: Surface): void {
		const note = this.note;
		if (!note) return;
		const at = this.sentence?.start ?? this.word?.start ?? 0;
		const oldSession = this.session;
		// Keep the note but drop the session: new token, no late events.
		this.endSession({ keepSurface: fresh });
		if (oldSession) void oldSession.stop().catch(() => {});
		if (isBlank(fresh.text)) {
			this.endSession();
			this.setState({ kind: "idle" });
			return;
		}
		const token = this.token;
		this.adoptNote(note, token);
		const start = remapOffset(oldText, fresh.text, at);
		void this.beginRead(note, fresh, start, token);
	}

	/** Forget the current session or attempt (the caller sets the state). */
	private endSession(opts: { keepSurface?: Surface } = {}): void {
		this.token++;
		for (const u of this.sessionUnsubs) u();
		this.sessionUnsubs = [];
		this.noteUnsub?.();
		this.noteUnsub = null;
		if (this.editTimer) nodeTimers.clearTimeout(this.editTimer);
		this.editTimer = null;
		if (this.hotkeyTimer) nodeTimers.clearTimeout(this.hotkeyTimer);
		this.hotkeyTimer = null;
		if (this.surface && this.surface !== opts.keepSurface) {
			this.surface.clear();
			this.surface.dispose();
		}
		this.surface = opts.keepSurface ?? null;
		this.session = null;
		this.note = null;
		this.noteDirty = false;
		this.pendingRestart = false;
		this.openedWithMore = false;
		this.sessionText = null;
		this.word = null;
		this.sentence = null;
		this.needsRepaint = false;
		this.lastError = null;
		this.hotkeyPending = false;
	}

	// ----- connection -----

	private async refreshAvailability(): Promise<void> {
		if (this.disposed) return;
		const k = this._state.kind;
		if (k !== "idle" && k !== "notInstalled" && k !== "notRunning") return;
		if (this.client.state.kind === "connected") {
			if (k !== "idle") this.setState({ kind: "idle" });
			return;
		}
		let availability: "notInstalled" | "installed" | "running";
		try {
			availability = await this.client.availability();
		} catch (e) {
			this.log(`availability failed: ${describe(e).message ?? String(e)}`);
			return;
		}
		const now = this._state.kind;
		if (now !== "idle" && now !== "notInstalled" && now !== "notRunning") return;
		this.setState(
			availability === "notInstalled"
				? { kind: "notInstalled" }
				: availability === "installed"
					? { kind: "notRunning" }
					: { kind: "idle" },
		);
	}

	private async connectQuietly(): Promise<boolean> {
		if (this.disposed || this.quietInFlight || this.client.state.kind !== "disconnected") {
			return this.client.state.kind === "connected";
		}
		this.quietInFlight = true;
		try {
			const server = await this.client.connectQuietly();
			if (server) this.server = server;
			return server !== null;
		} catch (e) {
			this.log(`quiet connect failed: ${describe(e).code ?? describe(e).message ?? String(e)}`);
			return false;
		} finally {
			this.quietInFlight = false;
		}
	}

	private connectionChanged(st: ConnectionState): void {
		const starting = this.isStarting && !this.hotkeyPending;
		switch (st.kind) {
			case "connected":
				this.server = st.server;
				this.wasConnected = true;
				this.cancelReconnect();
				if (this._state.kind === "notRunning" || this._state.kind === "notInstalled") {
					this.setState({ kind: "idle" });
				} else if (this._state.kind === "consentPending") {
					this.setState({ kind: "connecting" });
				}
				return;
			case "awaitingConsent":
				if (starting) this.setState({ kind: "consentPending" });
				return;
			case "launching":
				if (starting) this.setState({ kind: "connecting", detail: "Starting Univocal…" });
				return;
			case "connecting":
				if (starting && this._state.kind !== "consentPending") {
					this.setState({ kind: "connecting", detail: "Connecting to Univocal…" });
				}
				return;
			case "disconnected": {
				const was = this.wasConnected;
				this.wasConnected = false;
				if (this.session) {
					// The socket is gone; so is the session.
					this.endSession();
					const message = "Lost the connection to Univocal";
					this.setState({ kind: "failed", message });
					this.notify(message);
				}
				if (was && !this.closing && !this.disposed) this.scheduleReconnect(0);
				else void this.refreshAvailability();
			}
		}
	}

	private consentChanged(ev: ConsentEvent): void {
		if (ev.kind === "pending" && this.isStarting && !this.hotkeyPending) {
			this.setState({ kind: "consentPending" });
		}
		// `denied` / `granted` also settle the pending `connect()`, handled there.
	}

	/** Backoff 1/2/4 s after a dropped connection (SPEC §16.9); then wait for the next launch. */
	private scheduleReconnect(attempt: number): void {
		this.cancelReconnect();
		const delays = this.opts.reconnectDelaysMs ?? [1000, 2000, 4000];
		const delay = delays[attempt];
		if (delay === undefined) {
			void this.refreshAvailability();
			return;
		}
		this.reconnectTimer = nodeTimers.setTimeout(() => {
			this.reconnectTimer = null;
			void this.connectQuietly().then((ok) => {
				if (!ok && !this.disposed && this.client.state.kind === "disconnected") this.scheduleReconnect(attempt + 1);
			});
		}, delay);
	}

	private cancelReconnect(): void {
		if (this.reconnectTimer) nodeTimers.clearTimeout(this.reconnectTimer);
		this.reconnectTimer = null;
	}

	/** Map a `connect()` / `read()` rejection to a state (and a Notice when `loud`). */
	private failConnect(e: unknown, loud: boolean): void {
		const { code, reason, message } = describe(e);
		this.endSession();
		let next: ReaderState;
		let notice: string | null = null;
		switch (code) {
			case "notInstalled":
				next = { kind: "notInstalled" };
				notice = "Read aloud needs the Univocal app.";
				break;
			case "notRunning":
				next = { kind: "notRunning" };
				notice = "Univocal isn't running.";
				break;
			case "consentDenied":
				if (reason === "quiet") {
					next = { kind: "idle" };
				} else {
					next = { kind: "denied", message: consentMessage(reason) };
					notice = next.message;
				}
				break;
			case "unauthorized":
				next = { kind: "denied", message: REVOKED_MESSAGE };
				notice = REVOKED_MESSAGE;
				break;
			case "unsupportedVersion":
				next = { kind: "failed", message: "Update Univocal to read aloud from Obsidian" };
				notice = next.message;
				break;
			case "timeout":
				next = { kind: "failed", message: "Univocal didn't answer" };
				notice = next.message;
				break;
			case "transport":
				next = { kind: "failed", message: "Lost the connection to Univocal" };
				notice = next.message;
				break;
			default:
				next = { kind: "failed", message: message || "Couldn't start reading" };
				notice = next.message;
		}
		this.setState(next);
		if (loud && notice) this.notify(notice);
	}
}
