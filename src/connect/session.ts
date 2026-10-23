import { Emitter } from "./emitter";
import { UnivocalError } from "./errors";
import type { Logger, ReadingSession, ReadingSessionEvents, SessionState, Unsubscribe } from "./types";

/** What a session needs from its client (kept narrow so the session is testable alone). */
export interface SessionHost {
	control(session: ReadingSessionImpl, type: "pause" | "resume" | "stop" | "seek" | "setRate", fields?: Record<string, unknown>): Promise<void>;
}

type QueuedEvent = { [K in keyof ReadingSessionEvents]: [K, ReadingSessionEvents[K]] }[keyof ReadingSessionEvents];

/**
 * One reading session. Events are queued until the creating call has
 * returned the session to its caller (`release()`, one macrotask later), so a
 * caller that subscribes right after `await client.read()` never misses the
 * first `state{loading}`.
 */
export class ReadingSessionImpl implements ReadingSession {
	readonly id: string;
	readonly token: number;
	/** UTF-16 length of text sent so far. */
	textLength: number;
	/** UTF-8 bytes of text sent so far. */
	textBytes: number;
	/** `append` is still allowed (the last chunk went out with `more:true`). */
	open: boolean;
	/** The opening `read` frame has been sent. */
	started = false;
	/** The server acknowledged at least one chunk. */
	acked = false;

	private _ended = false;
	private _state: SessionState | "ended" = "loading";
	private readonly emitter: Emitter<ReadingSessionEvents>;
	private held = true;
	private queue: QueuedEvent[] = [];

	constructor(
		id: string,
		token: number,
		private readonly host: SessionHost,
		logger?: Logger,
	) {
		this.id = id;
		this.token = token;
		this.textLength = 0;
		this.textBytes = 0;
		this.open = false;
		this.emitter = new Emitter<ReadingSessionEvents>(logger);
	}

	get ended(): boolean {
		return this._ended;
	}

	get state(): SessionState | "ended" {
		return this._state;
	}

	on<K extends keyof ReadingSessionEvents>(event: K, listener: (payload: ReadingSessionEvents[K]) => void): Unsubscribe {
		return this.emitter.on(event, listener);
	}

	pause(): Promise<void> {
		return this.host.control(this, "pause");
	}

	resume(): Promise<void> {
		return this.host.control(this, "resume");
	}

	/** Idempotent: resolves at once if the session already ended. */
	stop(): Promise<void> {
		if (this._ended) return Promise.resolve();
		return this.host.control(this, "stop").catch((e: unknown) => {
			if (this._ended || (e instanceof UnivocalError && (e.code === "noSession" || e.code === "sessionEnded"))) return;
			throw e;
		});
	}

	seek(offset: number): Promise<void> {
		if (!Number.isInteger(offset) || offset < 0 || offset > this.textLength) {
			return Promise.reject(new UnivocalError("invalidOffset", `offset ${offset} is outside 0…${this.textLength}.`, { sessionId: this.id }));
		}
		return this.host.control(this, "seek", { offset });
	}

	setRate(rate: number): Promise<void> {
		if (!Number.isFinite(rate) || rate <= 0) {
			return Promise.reject(new UnivocalError("invalidArgument", "rate must be a finite positive number.", { sessionId: this.id }));
		}
		return this.host.control(this, "setRate", { rate });
	}

	/** Deliver an event (internal). Nothing is delivered after `ended`. */
	deliver<K extends keyof ReadingSessionEvents>(event: K, payload: ReadingSessionEvents[K]): void {
		if (this._ended) return;
		if (event === "ended") {
			this._ended = true;
			this._state = "ended";
			this.open = false;
		} else if (event === "state") {
			this._state = (payload as ReadingSessionEvents["state"]).state;
		}
		if (this.held) {
			this.queue.push([event, payload] as QueuedEvent);
			return;
		}
		this.emitter.emit(event, payload);
		if (event === "ended") this.emitter.clear();
	}

	/** Start delivering events (internal). Flushes the queue one macrotask later. */
	release(): void {
		if (!this.held) return;
		setTimeout(() => this.flush(), 0);
	}

	private flush(): void {
		if (!this.held) return;
		this.held = false;
		const q = this.queue;
		this.queue = [];
		for (const [event, payload] of q) {
			this.emitter.emit(event, payload as never);
			if (event === "ended") this.emitter.clear();
		}
	}
}
