/** Fakes for the controller tests: client, session, text map, highlighter, note, host. */
import { vi } from "vitest";
import type {
	ConnectCallOptions,
	ConnectionState,
	OffsetRange,
	ReadOptions,
	ReadRequest,
	ReadRequestHandler,
	ReadingSession,
	ReadingSessionEvents,
	ServerInfo,
	TokenStore,
	UnivocalClientEvents,
	Unsubscribe,
} from "../../src/connect/index";
import {
	type ConnectPort,
	type ControllerSettings,
	type NoteChange,
	type NoteHost,
	type NoteRef,
	ReadAloudController,
	type Surface,
	type SurfaceMode,
	createMappedSurface,
} from "../../src/controller";
import type { Highlighter } from "../../src/highlight/types";
import type { TextMap } from "../../src/textmap/types";

export const SERVER: ServerInfo = { name: "Univocal", version: "1.0", bundleId: "com.univocal.app" };

type AnyListener = (payload: never) => void;

class Emitter<E> {
	private readonly map = new Map<keyof E, Set<AnyListener>>();
	on<K extends keyof E>(event: K, listener: (payload: E[K]) => void): Unsubscribe {
		let set = this.map.get(event);
		if (!set) this.map.set(event, (set = new Set()));
		set.add(listener as AnyListener);
		return () => set.delete(listener as AnyListener);
	}
	emit<K extends keyof E>(event: K, payload: E[K]): void {
		for (const l of [...(this.map.get(event) ?? [])]) (l as (p: E[K]) => void)(payload);
	}
	count(event: keyof E): number {
		return this.map.get(event)?.size ?? 0;
	}
}

export class FakeSession implements ReadingSession {
	ended = false;
	readonly events = new Emitter<ReadingSessionEvents>();
	pause = vi.fn(async () => this.emit("state", { state: "paused" }));
	resume = vi.fn(async () => this.emit("state", { state: "playing" }));
	stop = vi.fn(async () => {
		this.ended = true;
	});
	seek = vi.fn(async () => {});
	setRate = vi.fn(async () => {});
	constructor(readonly id: string) {}
	on<K extends keyof ReadingSessionEvents>(event: K, listener: (payload: ReadingSessionEvents[K]) => void): Unsubscribe {
		return this.events.on(event, listener);
	}
	emit<K extends keyof ReadingSessionEvents>(event: K, payload: ReadingSessionEvents[K]): void {
		if (event === "ended") this.ended = true;
		this.events.emit(event, payload);
	}
	word(start: number, end: number): void {
		this.emit("word", { start, end });
	}
	sentence(start: number, end: number): void {
		this.emit("sentence", { start, end });
	}
}

export class FakeClient implements ConnectPort {
	state: ConnectionState = { kind: "disconnected" };
	readonly events = new Emitter<UnivocalClientEvents>();
	availabilityResult: "notInstalled" | "installed" | "running" = "running";
	connectImpl: (opts?: ConnectCallOptions) => Promise<ServerInfo> = async () => {
		this.setConnection({ kind: "connected", server: SERVER, capabilities: [], limits: { maxFrameBytes: 1 << 20, maxTextBytes: 8 << 20, rate: { min: 0.5, max: 3 } } });
		return SERVER;
	};
	quietResult: ServerInfo | null = null;
	readHandler: ReadRequestHandler | undefined;
	readonly sessions: FakeSession[] = [];
	readCalls: { text: string; opts: ReadOptions & { more?: boolean } }[] = [];

	availability = vi.fn(async () => this.availabilityResult);
	connect = vi.fn((opts?: ConnectCallOptions) => this.connectImpl(opts));
	connectQuietly = vi.fn(async () => this.quietResult);
	read = vi.fn(async (text: string, opts?: ReadOptions) => {
		this.readCalls.push({ text, opts: opts ?? {} });
		const s = new FakeSession(`s${this.sessions.length + 1}`);
		this.sessions.push(s);
		return s;
	});
	append = vi.fn(async (_s: ReadingSession, _text: string, _more: boolean) => {});
	disconnect = vi.fn(() => this.setConnection({ kind: "disconnected" }));
	setConnectDir = vi.fn((_dir: string | undefined) => {});

	onReadRequest(handler: ReadRequestHandler): Unsubscribe {
		this.readHandler = handler;
		return () => {
			this.readHandler = undefined;
		};
	}
	on<K extends keyof UnivocalClientEvents>(event: K, listener: (payload: UnivocalClientEvents[K]) => void): Unsubscribe {
		return this.events.on(event, listener);
	}
	setConnection(state: ConnectionState): void {
		this.state = state;
		this.events.emit("connection", state);
	}
	connected(): void {
		this.state = { kind: "connected", server: SERVER, capabilities: [], limits: { maxFrameBytes: 1 << 20, maxTextBytes: 8 << 20, rate: { min: 0.5, max: 3 } } };
	}
	get lastSession(): FakeSession {
		const s = this.sessions[this.sessions.length - 1];
		if (!s) throw new Error("no session");
		return s;
	}
	request(over: Partial<ReadRequest> = {}): ReturnType<ReadRequestHandler> {
		if (!this.readHandler) throw new Error("no readRequest handler");
		return this.readHandler({ requestId: "r1", trigger: "hotkey", prefer: "selection", answerMs: 300, acceptedMs: 1500, ...over });
	}
}

/** Stands in for `CSS.highlights`: what is painted is the union of live highlighters' ranges. */
export class FakeRegistry {
	readonly all: FakeHighlighter[] = [];
	create(): FakeHighlighter {
		const h = new FakeHighlighter();
		this.all.push(h);
		return h;
	}
	paintedWords(): OffsetRange[] {
		return this.all.filter((h) => !h.disposed && h.word).map((h) => h.word as OffsetRange);
	}
	paintedSentences(): OffsetRange[] {
		return this.all.filter((h) => !h.disposed && h.sentence).map((h) => h.sentence as OffsetRange);
	}
}

export class FakeHighlighter implements Highlighter<OffsetRange> {
	word: OffsetRange | null = null;
	sentence: OffsetRange | null = null;
	disposed = false;
	clears = 0;
	setWord(range: OffsetRange | null): void {
		if (this.disposed) return;
		this.word = range;
	}
	setSentence(range: OffsetRange | null): void {
		if (this.disposed) return;
		this.sentence = range;
	}
	clear(): void {
		this.clears++;
		this.word = null;
		this.sentence = null;
	}
	dispose(): void {
		this.clear();
		this.disposed = true;
	}
}

export function identityMap(text: string): TextMap<OffsetRange> {
	return {
		text,
		rangeFor: (start, end) => ({ start: Math.max(0, start), end: Math.min(text.length, end) }),
	};
}

export class FakeNote implements NoteRef {
	alive = true;
	selection: number | null = null;
	firstVisible = 0;
	complete = true;
	surfaces = 0;
	private readonly listeners = new Set<(c: NoteChange) => void>();

	constructor(
		public text: string,
		readonly registry: FakeRegistry,
		readonly mode: SurfaceMode = "live-preview",
		readonly path = "Note.md",
	) {}

	get title(): string {
		return this.path.replace(/\.md$/, "");
	}
	isEmpty(): boolean {
		return !/\S/.test(this.text);
	}
	isAlive(): boolean {
		return this.alive;
	}
	createSurface(): Surface {
		this.surfaces++;
		return createMappedSurface({
			mode: this.mode,
			map: identityMap(this.text),
			highlighter: () => this.registry.create(),
			selectionOffset: () => this.selection,
			firstVisibleOffset: () => this.firstVisible,
			complete: () => this.complete,
		});
	}
	onChange(listener: (change: NoteChange) => void): Unsubscribe {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	change(change: NoteChange): void {
		for (const l of [...this.listeners]) l(change);
	}
	get listenerCount(): number {
		return this.listeners.size;
	}
}

export class FakeHost implements NoteHost {
	note: NoteRef | null = null;
	focused = true;
	activeNote(): NoteRef | null {
		return this.note;
	}
	windowHasFocus(): boolean {
		return this.focused;
	}
}

export class MemoryTokenStore implements TokenStore {
	readonly tokens = new Map<string, string>();
	get = vi.fn(async (id: string) => this.tokens.get(id) ?? null);
	set = vi.fn(async (id: string, token: string) => {
		this.tokens.set(id, token);
	});
	delete = vi.fn(async (id: string) => {
		this.tokens.delete(id);
	});
}

export interface Rig {
	client: FakeClient;
	host: FakeHost;
	registry: FakeRegistry;
	note: FakeNote;
	settings: ControllerSettings;
	tokens: MemoryTokenStore;
	notices: string[];
	controller: ReadAloudController;
	states: string[];
}

export function rig(text = "One fish. Two fish. Red fish. Blue fish.", mode: SurfaceMode = "live-preview"): Rig {
	const client = new FakeClient();
	const host = new FakeHost();
	const registry = new FakeRegistry();
	const note = new FakeNote(text, registry, mode);
	host.note = note;
	const settings: ControllerSettings = { rate: 1.25, hotkeyRouting: true };
	const tokens = new MemoryTokenStore();
	const notices: string[] = [];
	const controller = new ReadAloudController({
		client,
		host,
		settings: () => settings,
		tokenStore: tokens,
		defaultServerBundleId: "com.univocal.app",
		notify: (m) => notices.push(m),
		editDebounceMs: 300,
	});
	const states: string[] = [];
	controller.onChange((s) => states.push(s.kind));
	return { client, host, registry, note, settings, tokens, notices, controller, states };
}

/** Let pending promise callbacks run. */
export async function flush(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}
