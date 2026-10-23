/**
 * Client state machine against an in-process fake server (no mock binary
 * needed). Tokens are in memory only.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type ConnectOptions,
	type ConsentEvent,
	InMemoryTokenStore,
	type OffsetRange,
	type ReadingSession,
	type ReadRequestHandler,
	type TokenStore,
	UnivocalClient,
	UnivocalError,
} from "../../src/connect/index";
import { FakeServer, WELCOME } from "./helpers/fakeServer";
import { sleep, waitFor } from "./helpers/mock";

const BUNDLE = "com.univocal.app";
const servers: FakeServer[] = [];
const clients: UnivocalClient[] = [];

afterEach(async () => {
	for (const c of clients.splice(0)) c.disconnect();
	for (const s of servers.splice(0)) await s.close();
});

async function setup(opts: Partial<ConnectOptions> = {}, serverOpts: { discovery?: boolean } = {}) {
	const server = await FakeServer.start(serverOpts);
	servers.push(server);
	const store = (opts.tokenStore as InMemoryTokenStore | undefined) ?? new InMemoryTokenStore();
	const launches: string[] = [];
	const client = new UnivocalClient({
		connectDir: server.dir,
		clientInfo: { id: "md.obsidian.plugin.univocal", name: "Obsidian", version: "1.0.0" },
		capabilities: ["word-events", "sentence-events", "hotkey-target"],
		tokenStore: store,
		isInstalled: async () => true,
		launcher: async (id) => {
			launches.push(id);
		},
		...opts,
	});
	clients.push(client);
	const key = client.tokenKey(BUNDLE);
	return { server, client, store, launches, key };
}

async function connected(opts: Partial<ConnectOptions> = {}, welcome?: Record<string, unknown>) {
	const ctx = await setup(opts);
	const p = ctx.client.connect();
	const { conn, hello } = await ctx.server.acceptNext({ welcome });
	await p;
	return { ...ctx, conn, hello };
}

function record(s: ReadingSession) {
	const log: string[] = [];
	const words: OffsetRange[] = [];
	s.on("word", (w) => (words.push(w), log.push(`word ${w.start}-${w.end}`)));
	s.on("sentence", (w) => log.push(`sentence ${w.start}-${w.end}`));
	s.on("state", (e) => log.push(`state ${e.state}`));
	s.on("ended", (e) => log.push(`ended ${e.reason}`));
	s.on("error", (e) => log.push(`error ${e.code}`));
	return { log, words };
}

describe("discovery and launch", () => {
	it("uses the socket path from connect.json; a dead pid means not running", async () => {
		const { server, client, launches } = await setup();
		server.writeDiscovery({ pid: 2 ** 22 + 12345 }); // no such process
		await expect(client.connect()).rejects.toMatchObject({ code: "notRunning" });
		expect(client.state).toMatchObject({ kind: "disconnected", error: { code: "notRunning" } });
		expect(await client.availability()).toBe("installed");
		expect(launches).toEqual([]);
	});

	it("notInstalled when the app is missing", async () => {
		const { server, client } = await setup({ isInstalled: async () => false });
		server.removeDiscovery();
		expect(await client.availability()).toBe("notInstalled");
		await expect(client.connect({ launch: true })).rejects.toMatchObject({ code: "notInstalled" });
	});

	it("never launches unless connect({launch:true}); then waits for discovery", async () => {
		const { server, client, launches } = await setup({}, { discovery: false });
		await expect(client.connect()).rejects.toMatchObject({ code: "notRunning" });
		expect(await client.connectQuietly()).toBeNull();
		expect(launches).toEqual([]);

		const states: string[] = [];
		client.on("connection", (s) => states.push(s.kind));
		const p = client.connect({ launch: true });
		await waitFor(() => launches.length === 1, 2000, "launch");
		expect(launches).toEqual(["com.univocal.app"]);
		setTimeout(() => server.writeDiscovery(), 300);
		await server.acceptNext();
		await p;
		expect(states).toEqual(["connecting", "launching", "connecting", "connected"]);
	});

	it("available as running with a live connect.json", async () => {
		const { client } = await setup();
		expect(await client.availability()).toBe("running");
	});
});

describe("handshake", () => {
	it("sends hello first with protocol, versions, client and capabilities; no token on first contact", async () => {
		const { hello, client } = await connected();
		expect(hello).toEqual({
			type: "hello",
			protocol: "univocal-connect",
			versions: [1],
			client: { id: "md.obsidian.plugin.univocal", name: "Obsidian", version: "1.0.0" },
			capabilities: ["word-events", "sentence-events", "hotkey-target"],
		});
		expect(client.state).toMatchObject({ kind: "connected", server: WELCOME.server, limits: WELCOME.limits });
		expect(client.server).toEqual(WELCOME.server);
	});

	it("concurrent connect() calls share one attempt", async () => {
		const { server, client } = await setup();
		const a = client.connect();
		const b = client.connect();
		const c = client.read("Hello."); // read() also joins the same attempt
		const { conn } = await server.acceptNext();
		expect(await a).toEqual(await b);
		const read = await conn.next("read");
		conn.ok(read);
		await c;
		await sleep(50);
		expect(server.conns).toHaveLength(1);
		expect(conn.received.filter((m) => m.type === "hello")).toHaveLength(1);
	});

	it("consent: pending → granted → welcome; token stored, hello not re-sent", async () => {
		const { server, client, store, key } = await setup();
		const consent: ConsentEvent[] = [];
		const states: string[] = [];
		client.on("consent", (e) => consent.push(e));
		client.on("connection", (s) => states.push(s.kind));
		const p = client.connect();
		const { conn } = await server.acceptNext({ consent: "uc1_granted" });
		await p;
		await client.whenIdle();
		expect(consent).toEqual([
			{ kind: "pending", requestId: "c1", timeoutSeconds: 120 },
			{ kind: "granted", requestId: "c1" },
		]);
		expect(states).toEqual(["connecting", "awaitingConsent", "connected"]);
		expect(store.tokens.get(key)).toBe("uc1_granted");
		expect(key).toBe(`${BUNDLE}@${server.dir}`); // a test dir never shares the real Univocal's token
		await sleep(30);
		expect(conn.received.map((m) => m.type)).toEqual(["hello"]);
	});

	it("presents the stored token", async () => {
		const ctx = await setup();
		await ctx.store.set(ctx.key, "uc1_saved");
		const p = ctx.client.connect();
		const { hello } = await ctx.server.acceptNext();
		await p;
		expect(hello.token).toBe("uc1_saved");
	});

	it("a hanging token store never blocks the hello", async () => {
		const hanging: TokenStore = { get: () => new Promise(() => {}), set: async () => {}, delete: async () => {} };
		const { server, client } = await setup({ tokenStore: hanging, tokenTimeoutMs: 80 });
		const t0 = Date.now();
		const p = client.connect();
		const { hello } = await server.acceptNext();
		await p;
		expect(Date.now() - t0).toBeLessThan(1000);
		expect(hello.token).toBeUndefined();
	});

	it("a throwing token store connects without a token", async () => {
		const broken: TokenStore = {
			get: async () => {
				throw new Error("keychain locked");
			},
			set: async () => {
				throw new Error("keychain locked");
			},
			delete: async () => {},
		};
		const { server, client } = await setup({ tokenStore: broken });
		const p = client.connect();
		const { hello } = await server.acceptNext({ consent: "uc1_x" });
		await p;
		expect(hello.token).toBeUndefined();
		await client.whenIdle(); // the failed write is logged, not thrown
	});

	it("consentDenied{user} rejects and records the error", async () => {
		const { server, client } = await setup();
		const p = client.connect();
		const conn = await server.nextConnection();
		await conn.next("hello");
		conn.send({ type: "consentPending", requestId: "r", timeoutSeconds: 120 });
		conn.send({ type: "consentDenied", requestId: "r", reason: "user" });
		const err = (await p.catch((e: unknown) => e)) as UnivocalError;
		expect(err.connectError).toEqual({ code: "consentDenied", reason: "user" });
		expect(client.state).toEqual({ kind: "disconnected", error: { code: "consentDenied", reason: "user" } });
	});

	it("connectQuietly: no token → no connection at all", async () => {
		const { server, client } = await setup();
		expect(await client.connectQuietly()).toBeNull();
		await sleep(50);
		expect(server.conns).toHaveLength(0);
	});

	it("connectQuietly: hello{quiet:true}; consentDenied{quiet} deletes the token and stays idle", async () => {
		const ctx = await setup({ reconnectDelaysMs: [20, 20, 20], pollIntervalMs: 50 });
		await ctx.store.set(ctx.key, "uc1_stale");
		const p = ctx.client.connectQuietly();
		const conn = await ctx.server.nextConnection();
		const hello = await conn.next("hello");
		expect(hello).toMatchObject({ quiet: true, token: "uc1_stale" });
		conn.send({ type: "consentDenied", requestId: "q", reason: "quiet" });
		expect(await p).toBeNull();
		await ctx.client.whenIdle();
		expect(ctx.store.tokens.has(ctx.key)).toBe(false);
		await sleep(200);
		expect(ctx.server.conns).toHaveLength(1); // no retry without a user action
	});

	it("a user connect() after a quiet denial proceeds without quiet", async () => {
		const ctx = await setup();
		await ctx.store.set(ctx.key, "uc1_stale");
		const quiet = ctx.client.connectQuietly();
		const conn = await ctx.server.nextConnection();
		await conn.next("hello");
		const loud = ctx.client.connect();
		conn.send({ type: "consentDenied", requestId: "q", reason: "quiet" });
		expect(await quiet).toBeNull();
		const { hello } = await ctx.server.acceptNext({ consent: "uc1_new" });
		await loud;
		expect(hello.quiet).toBeUndefined();
	});

	it("unauthorized{revoked}: token dropped, no reconnect within the hold", async () => {
		const ctx = await setup({ reconnectDelaysMs: [20] });
		await ctx.store.set(ctx.key, "uc1_t");
		const p = ctx.client.connect();
		const { conn } = await ctx.server.acceptNext();
		await p;
		conn.send({ type: "error", code: "unauthorized", reason: "revoked", message: "revoked", fatal: true });
		conn.end();
		await waitFor(() => ctx.client.state.kind === "disconnected", 2000, "disconnect");
		await ctx.client.whenIdle();
		expect(ctx.store.tokens.has(ctx.key)).toBe(false);
		expect(ctx.client.state).toMatchObject({ error: { code: "unauthorized", reason: "revoked" } });
		await expect(ctx.client.connect()).rejects.toMatchObject({ code: "unauthorized", reason: "revoked" });
		await sleep(100);
		expect(ctx.server.conns).toHaveLength(1);
	});

	it("handshake timeout", async () => {
		const { server, client } = await setup();
		const p = client.connect({ timeoutMs: 100 });
		await server.nextConnection();
		await expect(p).rejects.toMatchObject({ code: "timeout" });
	});

	it("rejects an unsupported discovery version", async () => {
		const { server, client } = await setup();
		server.writeDiscovery({ versions: [2] });
		await expect(client.connect()).rejects.toMatchObject({ code: "unsupportedVersion" });
	});
});

describe("robustness", () => {
	it("ignores unknown types and fields, answers ping, survives malformed lines", async () => {
		const { conn, client } = await connected();
		conn.send({ type: "x-future-thing", whatever: 1 });
		conn.sendRaw("{this is not json}\n\r\n");
		conn.send({ type: "ping", id: 42 });
		expect(await conn.next("pong")).toEqual({ type: "pong", id: 42 });
		expect(client.state.kind).toBe("connected");
	});

	it("a giant frame from the server closes the connection as protocolError", async () => {
		const { conn, client } = await connected();
		conn.sendRaw(`{"type":"x","pad":"${"a".repeat(1_100_000)}"}\n`);
		await waitFor(() => client.state.kind === "disconnected", 3000, "disconnect");
		expect(client.state).toMatchObject({ error: { code: "protocolError" } });
	});
});

describe("reading", () => {
	it("read → ok → events in order, first state{loading} not missed", async () => {
		const { conn, client } = await connected();
		const text = "Revenue reached $5B.\n\nNext year looks brighter.";
		const p = client.read(text, { title: "Q3.md", rate: 1.25, startOffset: 3, lang: "en" });
		const read = await conn.next("read");
		expect(read).toMatchObject({ type: "read", text, preempt: true, more: false, rate: 1.25, startOffset: 3, lang: "en", meta: { title: "Q3.md" } });
		expect(typeof read.id).toBe("number");
		// Everything in one TCP write: ok + first events.
		conn.sendRaw(
			[
				{ type: "ok", id: read.id, sessionId: read.sessionId },
				{ type: "state", sessionId: read.sessionId, state: "loading" },
				{ type: "state", sessionId: read.sessionId, state: "playing" },
				{ type: "sentence", sessionId: read.sessionId, start: 0, end: 20 },
				{ type: "word", sessionId: read.sessionId, start: 16, end: 19 },
				{ type: "word", sessionId: read.sessionId, start: 16, end: 19 },
			]
				.map((m) => JSON.stringify(m) + "\n")
				.join(""),
		);
		const s = await p;
		const r = record(s);
		await waitFor(() => r.log.length === 5, 2000, "events");
		expect(r.log).toEqual(["state loading", "state playing", "sentence 0-20", "word 16-19", "word 16-19"]);
		expect(s.state).toBe("playing");
		conn.send({ type: "ended", sessionId: read.sessionId, reason: "finished" });
		conn.send({ type: "word", sessionId: read.sessionId, start: 22, end: 26 }); // after ended: dropped
		await waitFor(() => s.ended, 2000, "ended");
		await sleep(20);
		expect(r.log.slice(-1)).toEqual(["ended finished"]);
	});

	it("drops out-of-range and inverted ranges", async () => {
		const { conn, client } = await connected();
		const p = client.read("Hello there.");
		const read = await conn.next("read");
		conn.ok(read);
		const s = await p;
		const r = record(s);
		for (const [a, b] of [[5, 5], [6, 3], [-1, 2], [0, 99], [0, 5]]) conn.send({ type: "word", sessionId: read.sessionId, start: a, end: b });
		await waitFor(() => r.words.length === 1, 2000, "valid word");
		await sleep(30);
		expect(r.words).toEqual([{ start: 0, end: 5 }]);
	});

	it("controls carry sessionId and await ok; seek is range-checked locally", async () => {
		const { conn, client } = await connected();
		const p = client.read("One two three.");
		const read = await conn.next("read");
		conn.ok(read);
		const s = await p;
		for (const [call, type, extra] of [
			[() => s.pause(), "pause", {}],
			[() => s.resume(), "resume", {}],
			[() => s.seek(4), "seek", { offset: 4 }],
			[() => s.setRate(1.5), "setRate", { rate: 1.5 }],
		] as const) {
			const done = call();
			const m = await conn.next(type);
			expect(m).toMatchObject({ type, sessionId: read.sessionId, ...extra });
			conn.ok(m);
			await done;
		}
		await expect(s.seek(999)).rejects.toMatchObject({ code: "invalidOffset" });
		const pause = s.pause();
		const m = await conn.next("pause");
		conn.send({ type: "error", id: m.id, sessionId: read.sessionId, code: "noSession", message: "gone", fatal: false });
		await expect(pause).rejects.toMatchObject({ code: "noSession" });
		const stop = s.stop();
		const st = await conn.next("stop");
		conn.ok(st);
		conn.send({ type: "ended", sessionId: read.sessionId, reason: "stopped" });
		await stop;
		await waitFor(() => s.ended, 1000, "ended");
		await expect(s.pause()).rejects.toMatchObject({ code: "sessionEnded" });
		await s.stop(); // idempotent
	});

	it("session-scoped server errors reach the session", async () => {
		const { conn, client } = await connected();
		const p = client.read("Text.");
		const read = await conn.next("read");
		conn.ok(read);
		const r = record(await p);
		conn.send({ type: "error", sessionId: read.sessionId, code: "engineError", message: "boom", fatal: false });
		conn.send({ type: "ended", sessionId: read.sessionId, reason: "error" });
		await waitFor(() => r.log.length === 2, 2000, "error + ended");
		expect(r.log).toEqual(["error engineError", "ended error"]);
	});

	it("late events from an older session are dropped; it ends locally before the new one starts", async () => {
		const { conn, client } = await connected();
		const p1 = client.read("First text here.");
		const r1msg = await conn.next("read");
		conn.ok(r1msg);
		const s1 = await p1;
		const r1 = record(s1);
		conn.send({ type: "word", sessionId: r1msg.sessionId, start: 0, end: 5 });
		await waitFor(() => r1.words.length === 1, 1000, "s1 word");

		const p2 = client.read("Second text here.");
		const r2msg = await conn.next("read");
		expect(r1.log.slice(-1)).toEqual(["ended preempted"]); // ended locally before the new read went out
		// The server's late traffic for s1 (still in flight) arrives interleaved with s2's.
		conn.send({ type: "word", sessionId: r1msg.sessionId, start: 6, end: 10 });
		conn.ok(r2msg);
		conn.send({ type: "ended", sessionId: r1msg.sessionId, reason: "preempted", by: "Obsidian" });
		conn.send({ type: "word", sessionId: r2msg.sessionId, start: 0, end: 6 });
		const s2 = await p2;
		const r2 = record(s2);
		await waitFor(() => r2.words.length === 1, 1000, "s2 word");
		await sleep(30);
		expect(r1.words).toHaveLength(1);
		expect(r1.log.filter((l) => l.startsWith("ended"))).toHaveLength(1);
		expect(s2.token).toBeGreaterThan(s1.token ?? Infinity);
	});

	it("chunks long text: read{more:true} + append, offsets global, last chunk more:false", async () => {
		const { conn, client } = await connected();
		const para = "A sentence that goes on for a while to fill space. ".repeat(40);
		const text = Array.from({ length: 700 }, () => para).join("\n\n"); // ~1.4 MB
		const p = client.read(text);
		const parts: string[] = [];
		const mores: boolean[] = [];
		for (;;) {
			const m = await conn.next();
			if (m.type !== "read" && m.type !== "append") continue;
			parts.push(m.text as string);
			mores.push(m.more as boolean);
			conn.ok(m);
			if (m.more === false) break;
		}
		const s = await p;
		expect(parts.join("")).toBe(text);
		expect(parts.length).toBeGreaterThanOrEqual(3);
		expect(mores.slice(0, -1).every(Boolean)).toBe(true);
		for (const part of parts.slice(0, -1)) expect(part.endsWith("\n\n")).toBe(true);
		expect(s.textLength).toBe(text.length);
		conn.send({ type: "word", sessionId: s.id, start: text.length - 6, end: text.length - 1 });
		const r = record(s);
		await waitFor(() => r.words.length === 1, 1000, "late-offset word");
	});

	it("read({more:true}) then append(…, more) for virtualised notes", async () => {
		const { conn, client } = await connected();
		const p = client.read("Visible part.\n\n", { more: true });
		const m1 = await conn.next("read");
		expect(m1.more).toBe(true);
		conn.ok(m1);
		const s = await p;
		const a = client.append(s, "Lazy part.", false);
		const m2 = await conn.next("append");
		expect(m2).toMatchObject({ type: "append", sessionId: s.id, text: "Lazy part.", more: false });
		conn.ok(m2);
		await a;
		expect(s.textLength).toBe("Visible part.\n\nLazy part.".length);
		await expect(client.append(s, "more", false)).rejects.toMatchObject({ code: "invalidArgument" });
	});

	it("refuses text over limits.maxTextBytes before sending anything", async () => {
		const { conn, client } = await connected({}, { limits: { maxFrameBytes: 1_048_576, maxTextBytes: 100, rate: { min: 0.5, max: 2 } } });
		await expect(client.read("é".repeat(51))).rejects.toMatchObject({ code: "textTooLarge" });
		await expect(client.read("")).rejects.toMatchObject({ code: "invalidArgument" });
		await expect(client.read("abc", { startOffset: 4 })).rejects.toMatchObject({ code: "invalidOffset" });
		await sleep(30);
		expect(conn.received.map((m) => m.type)).toEqual(["hello"]);
	});

	it("an unexpected disconnect ends the session with an error, then reconnects quietly", async () => {
		const ctx = await setup({ reconnectDelaysMs: [30, 30, 30] });
		await ctx.store.set(ctx.key, "uc1_t");
		const p = ctx.client.connect();
		const { conn } = await ctx.server.acceptNext();
		await p;
		const rp = ctx.client.read("Text.");
		const read = await conn.next("read");
		conn.ok(read);
		const r = record(await rp);
		conn.end();
		await waitFor(() => r.log.length === 2, 2000, "session error + ended");
		expect(r.log).toEqual(["error disconnected", "ended error"]);
		const { hello } = await ctx.server.acceptNext();
		expect(hello).toMatchObject({ quiet: true, token: "uc1_t" });
		await waitFor(() => ctx.client.state.kind === "connected", 2000, "reconnected");
	});

	it("disconnect() ends the session as stopped and does not reconnect", async () => {
		const { conn, client, server } = await connected({ reconnectDelaysMs: [20] });
		const rp = client.read("Text.");
		const read = await conn.next("read");
		conn.ok(read);
		const r = record(await rp);
		client.disconnect();
		await waitFor(() => r.log.length === 1, 1000, "ended");
		expect(r.log).toEqual(["ended stopped"]);
		await sleep(100);
		expect(server.conns).toHaveLength(1);
		expect(client.state).toEqual({ kind: "disconnected" });
	});
});

describe("connection health", () => {
	it("gives up after the backoff, then reconnects when a new server pid appears", async () => {
		const ctx = await setup({ reconnectDelaysMs: [20, 20, 20], pollIntervalMs: 60 });
		await ctx.store.set(ctx.key, "uc1_t");
		const p = ctx.client.connect();
		const { conn } = await ctx.server.acceptNext();
		await p;
		// The server "quits": discovery removed, connection closed.
		ctx.server.removeDiscovery();
		conn.end();
		await sleep(300); // backoff exhausted (no live discovery)
		expect(ctx.server.conns).toHaveLength(1);
		// A new server launch: discovery reappears with another live pid (our parent's).
		ctx.server.writeDiscovery({ pid: process.ppid });
		const { hello } = await ctx.server.acceptNext();
		expect(hello.quiet).toBe(true);
		await waitFor(() => ctx.client.state.kind === "connected", 2000, "connected");
	});

	it("setConnectDir switches servers live", async () => {
		const a = await connected();
		a.store.tokens.set(a.client.tokenKey(BUNDLE), "uc1_a");
		const b = await FakeServer.start();
		servers.push(b);
		const keyB = `${BUNDLE}@${b.dir}`;
		a.store.tokens.set(keyB, "uc1_b");
		a.client.setConnectDir(b.dir);
		const { hello } = await b.acceptNext();
		expect(hello).toMatchObject({ quiet: true, token: "uc1_b" });
		await waitFor(() => a.client.state.kind === "connected", 2000, "connected to b");
		expect(a.conn.closed || a.server.conns[0]!.closed).toBe(true);
	});

	it("resolves the connect dir: option, then env, then the default", () => {
		const prev = process.env.UNIVOCAL_CONNECT_DIR;
		try {
			process.env.UNIVOCAL_CONNECT_DIR = "/tmp/claude-501/uco-env";
			const mk = (connectDir?: string, appBundleId?: string) =>
				new UnivocalClient({ connectDir, appBundleId, clientInfo: { id: "a.b", name: "n", version: "1" }, capabilities: [], tokenStore: new InMemoryTokenStore() });
			expect(mk("/x").connectDir).toBe("/x");
			expect(mk().connectDir).toBe("/tmp/claude-501/uco-env");
			delete process.env.UNIVOCAL_CONNECT_DIR;
			expect(mk().connectDir).toMatch(/Library\/Application Support\/Univocal\/Connect$/);
			expect(mk(undefined, "com.univocal.app.dev").connectDir).toMatch(/Univocal Dev\/Connect$/);
			expect(mk().tokenKey("com.univocal.app")).toBe("com.univocal.app");
		} finally {
			if (prev === undefined) delete process.env.UNIVOCAL_CONNECT_DIR;
			else process.env.UNIVOCAL_CONNECT_DIR = prev;
		}
	});

	it("rejects an invalid client id", () => {
		expect(() => new UnivocalClient({ clientInfo: { id: "bad id!", name: "n", version: "1" }, capabilities: [], tokenStore: new InMemoryTokenStore() })).toThrow(UnivocalError);
	});
});

describe("hotkey routing (readRequest)", () => {
	const REQ = { type: "readRequest", requestId: "h1", trigger: "hotkey", prefer: "selection", answerMs: 300, acceptedMs: 1500 };

	async function hk(handler?: ReadRequestHandler, welcome?: Record<string, unknown>) {
		const ctx = await connected({}, welcome);
		if (handler) ctx.client.onReadRequest(handler);
		return ctx;
	}

	it("answer kind:read → read{requestId, preempt:true, startOffset}", async () => {
		const sessions: ReadingSession[] = [];
		const seen: unknown[] = [];
		const { conn } = await hk((req) => {
			seen.push(req);
			return { kind: "read", text: "Whole document.", options: { startOffset: 6, preempt: false }, onSession: (s) => sessions.push(s) };
		});
		conn.send({ ...REQ, prefer: "document", extra: "ignored" });
		const read = await conn.next("read");
		expect(read).toMatchObject({ requestId: "h1", preempt: true, startOffset: 6, text: "Whole document." });
		expect(seen).toEqual([{ requestId: "h1", trigger: "hotkey", prefer: "document", answerMs: 300, acceptedMs: 1500 }]);
		conn.ok(read);
		await waitFor(() => sessions.length === 1, 1000, "onSession");
		expect(sessions[0]!.id).toBe(read.sessionId);
	});

	it("answer kind:accept → readAccepted immediately, then read", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const { conn } = await hk(() => ({
			kind: "accept",
			produce: async () => {
				await gate;
				return { text: "Later text." };
			},
		}));
		const t0 = Date.now();
		conn.send(REQ);
		expect(await conn.next("readAccepted")).toEqual({ type: "readAccepted", requestId: "h1" });
		expect(Date.now() - t0).toBeLessThan(50 + 200);
		release();
		const read = await conn.next("read");
		expect(read).toMatchObject({ requestId: "h1", text: "Later text." });
	});

	it("produce() → null declines noContent; decline passes reason and detail", async () => {
		let n = 0;
		const { conn } = await hk(() =>
			n++ === 0 ? { kind: "accept", produce: async () => null } : { kind: "decline", reason: "notFocused", detail: "popout" },
		);
		conn.send(REQ);
		expect(await conn.next("readDecline")).toEqual({ type: "readDecline", requestId: "h1", reason: "noContent" });
		conn.send({ ...REQ, requestId: "h2" });
		expect(await conn.next("readDecline")).toEqual({ type: "readDecline", requestId: "h2", reason: "notFocused", detail: "popout" });
	});

	it("no handler, a throwing handler, or empty text decline at once", async () => {
		const { conn, client } = await hk();
		conn.send(REQ);
		expect(await conn.next("readDecline")).toMatchObject({ requestId: "h1", reason: "other" });
		client.onReadRequest(() => {
			throw new Error("bug");
		});
		conn.send({ ...REQ, requestId: "h2" });
		expect(await conn.next("readDecline")).toMatchObject({ requestId: "h2", reason: "other" });
		client.onReadRequest(() => ({ kind: "read", text: "" }));
		conn.send({ ...REQ, requestId: "h3" });
		expect(await conn.next("readDecline")).toMatchObject({ requestId: "h3", reason: "noContent" });
	});

	it("ignores unknown triggers, duplicates, and servers without hotkey-routing", async () => {
		let calls = 0;
		const handler: ReadRequestHandler = () => (calls++, { kind: "decline", reason: "busy" });
		const a = await hk(handler);
		a.conn.send({ ...REQ, trigger: "gesture" });
		a.conn.send(REQ);
		a.conn.send(REQ);
		await a.conn.next("readDecline");
		await sleep(50);
		expect(calls).toBe(1);
		expect(a.conn.received.filter((m) => m.type === "readDecline")).toHaveLength(1);

		const b = await hk(handler, { capabilities: ["word-events"] });
		b.conn.send({ ...REQ, requestId: "z" });
		await sleep(50);
		expect(calls).toBe(1);
		expect(b.conn.received.map((m) => m.type)).toEqual(["hello"]);
	});

	it("error{unknownRequest} on the answering read is silent (no client error, stays connected)", async () => {
		const errors: unknown[] = [];
		const sessions: ReadingSession[] = [];
		const { conn, client } = await hk(() => ({ kind: "read", text: "Too late.", onSession: (s) => sessions.push(s) }));
		client.on("error", (e) => errors.push(e));
		conn.send(REQ);
		const read = await conn.next("read");
		conn.send({ type: "error", id: read.id, code: "unknownRequest", message: "expired", fatal: false });
		await sleep(50);
		expect(errors).toEqual([]);
		expect(sessions).toEqual([]);
		expect(client.state.kind).toBe("connected");
	});
});

describe("listVoices", () => {
	it("requests voices when the server offers them", async () => {
		const { conn, client } = await connected();
		const p = client.listVoices();
		const m = await conn.next("listVoices");
		conn.send({ type: "voices", id: m.id, default: "bf_emma", voices: [{ id: "bf_emma", name: "Emma", lang: "en-GB" }, { bad: true }] });
		expect(await p).toEqual({ default: "bf_emma", voices: [{ id: "bf_emma", name: "Emma", lang: "en-GB" }] });
	});
});

describe("connect dir path sanity", () => {
	it("fake server dirs stay under the sun_path limit", async () => {
		const s = await FakeServer.start();
		servers.push(s);
		expect(Buffer.byteLength(s.socketPath)).toBeLessThanOrEqual(103);
		expect(fs.existsSync(path.join(s.dir, "connect.json"))).toBe(true);
	});
});
