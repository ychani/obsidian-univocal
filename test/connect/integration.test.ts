/**
 * Integration tests against the real `univocal-mock` (skipped unless
 * UNIVOCAL_MOCK_BIN points at the binary). Tokens live in memory only.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	type ConnectionState,
	type ConsentEvent,
	InMemoryTokenStore,
	readDiscovery,
	type OffsetRange,
	type ReadingSession,
	type ReadRequest,
	type ReadRequestHandler,
	UnivocalClient,
	UnivocalError,
} from "../../src/connect/index";
import { hasMock, type Mock, sleep, startMock, waitFor } from "./helpers/mock";

/** The mock's bundle id as advertised in its connect.json (it also echoes it in welcome). */
const bundleOf = (mock: Mock) => readDiscovery(mock.dir)?.server.bundleId ?? "";
/** Token account for a non-default connect dir: `<bundleId>@<dir>` (never the real Univocal's). */
const key = (mock: Mock) => `${bundleOf(mock)}@${mock.dir}`;

let clientSeq = 0;
/** Unique client ids by default: the mock rate-limits consent to 3 per minute per identity. */
function makeClient(mock: Mock, store = new InMemoryTokenStore(), extra: { hotkey?: boolean; name?: string; id?: string } = {}) {
	return new UnivocalClient({
		connectDir: mock.dir,
		clientInfo: { id: extra.id ?? `md.obsidian.plugin.univocal.test${++clientSeq}`, name: extra.name ?? "Obsidian Test", version: "0.0.0" },
		capabilities: extra.hotkey ? ["word-events", "sentence-events", "hotkey-target"] : ["word-events", "sentence-events"],
		tokenStore: store,
		isInstalled: async () => true,
		launcher: async () => {
			throw new Error("tests must never launch Univocal");
		},
	});
}

function record(session: ReadingSession) {
	const words: OffsetRange[] = [];
	const sentences: OffsetRange[] = [];
	const states: string[] = [];
	const ended: { reason: string; by?: string }[] = [];
	session.on("word", (w) => words.push(w));
	session.on("sentence", (s) => sentences.push(s));
	session.on("state", (s) => states.push(s.state));
	session.on("ended", (e) => ended.push(e));
	return { words, sentences, states, ended };
}

const LONG = Array.from({ length: 40 }, (_, i) => `Sentence number ${i + 1} has a few words in it.`).join(" ");

describe.skipIf(!hasMock)("univocal-mock integration", () => {
	let mock: Mock;
	const clients: UnivocalClient[] = [];
	const track = (c: UnivocalClient) => (clients.push(c), c);

	beforeAll(async () => {
		mock = await startMock({ args: ["--wpm", "600", "--loading-ms", "30"] });
	});
	afterEach(() => {
		for (const c of clients.splice(0)) c.disconnect();
	});
	afterAll(async () => {
		await mock?.stop();
	});

	it("handshake + consent: pending → granted, token stored, no re-hello", async () => {
		const store = new InMemoryTokenStore();
		const client = track(makeClient(mock, store, { id: "test.consent" }));
		const states: ConnectionState["kind"][] = [];
		const consent: ConsentEvent["kind"][] = [];
		client.on("connection", (s) => states.push(s.kind));
		client.on("consent", (e) => consent.push(e.kind));
		const server = await client.connect();
		expect(server.bundleId).toBe(bundleOf(mock));
		expect(client.state.kind).toBe("connected");
		expect(client.serverCapabilities).toContain("hotkey-routing");
		expect(consent).toEqual(["pending", "granted"]);
		expect(states).toEqual(["connecting", "awaitingConsent", "connected"]);
		await client.whenIdle();
		expect(store.tokens.get(key(mock))).toMatch(/^uc1_/);
		expect(client.tokenKey(bundleOf(mock))).toBe(key(mock));

		// The stored token is presented next time: no consent round.
		client.disconnect();
		const again = track(makeClient(mock, store, { id: "test.consent" }));
		const consent2: string[] = [];
		again.on("consent", (e) => consent2.push(e.kind));
		await again.connect();
		expect(consent2).toEqual([]);
	});

	it("quiet hello: connects with a valid token, deletes an invalid one", async () => {
		const store = new InMemoryTokenStore();
		const first = track(makeClient(mock, store, { id: "test.quiet" }));
		await first.connect();
		await first.whenIdle();
		first.disconnect();

		const quiet = track(makeClient(mock, store, { id: "test.quiet" }));
		const consent: string[] = [];
		quiet.on("consent", (e) => consent.push(e.kind));
		expect(await quiet.connectQuietly()).toMatchObject({ name: "Univocal Mock" });
		expect(consent).toEqual([]);

		const bogus = new InMemoryTokenStore({ [key(mock)]: "uc1_not-a-real-token" });
		const denied = track(makeClient(mock, bogus));
		const events: ConsentEvent[] = [];
		denied.on("consent", (e) => events.push(e));
		expect(await denied.connectQuietly()).toBeNull();
		expect(events.map((e) => e.kind)).toEqual(["denied"]);
		expect(events[0]).toMatchObject({ reason: "quiet" });
		await denied.whenIdle();
		expect(bogus.tokens.has(key(mock))).toBe(false);

		// No token at all: nothing is sent.
		const none = track(makeClient(mock, new InMemoryTokenStore()));
		expect(await none.connectQuietly()).toBeNull();
		expect(none.state.kind).toBe("disconnected");
	});

	it("reads to the end with word events", async () => {
		const client = track(makeClient(mock));
		const text = "Revenue reached five billion.\n\nNext year looks brighter.";
		const session = await client.read(text, { title: "Q3.md" });
		const r = record(session);
		await waitFor(() => r.ended.length > 0, 10_000, "ended");
		expect(r.ended).toEqual([{ reason: "finished" }]);
		expect(r.states[0]).toBe("loading");
		expect(r.states).toContain("playing");
		expect(r.sentences.length).toBeGreaterThanOrEqual(2);
		expect(r.words.length).toBeGreaterThanOrEqual(8);
		for (let i = 1; i < r.words.length; i++) expect(r.words[i]!.start).toBeGreaterThanOrEqual(r.words[i - 1]!.start);
		const last = r.words[r.words.length - 1]!;
		expect(text.slice(last.start, last.end)).toBe("brighter");
		expect(session.ended).toBe(true);
	});

	it("pause / resume / stop", async () => {
		const client = track(makeClient(mock));
		const session = await client.read(LONG);
		const r = record(session);
		await waitFor(() => r.words.length >= 2, 10_000, "first words");
		await session.pause();
		await waitFor(() => session.state === "paused", 3000, "paused");
		const n = r.words.length;
		await sleep(400);
		expect(r.words.length).toBe(n);
		await session.resume();
		await waitFor(() => r.words.length > n, 3000, "words after resume");
		expect(r.states.slice(-1)[0]).toBe("playing");
		await session.stop();
		await waitFor(() => r.ended.length > 0, 3000, "ended");
		expect(r.ended[0]).toEqual({ reason: "stopped" });
		await session.stop(); // idempotent once ended
	});

	it("preemption: another client and Univocal itself", async () => {
		const a = track(makeClient(mock, new InMemoryTokenStore(), { id: "test.client.a", name: "Client A" }));
		const b = track(makeClient(mock, new InMemoryTokenStore(), { id: "test.client.b", name: "Client B" }));
		const sa = await a.read(LONG);
		const ra = record(sa);
		await waitFor(() => ra.words.length > 0, 10_000, "A words");
		const sb = await b.read(LONG);
		const rb = record(sb);
		await waitFor(() => ra.ended.length > 0, 3000, "A preempted");
		expect(ra.ended[0]!.reason).toBe("preempted");
		await waitFor(() => rb.words.length > 0, 10_000, "B words");
		expect(await mock.ctl("preempt")).toBeTruthy();
		await waitFor(() => rb.ended.length > 0, 3000, "B preempted by Univocal");
		expect(rb.ended[0]).toMatchObject({ reason: "preempted", by: "Univocal" });
	});

	it("a newer local session ends the older one first and drops its late events", async () => {
		const client = track(makeClient(mock));
		const s1 = await client.read(LONG);
		const r1 = record(s1);
		await waitFor(() => r1.words.length > 0, 10_000, "s1 words");
		const s2 = await client.read(LONG);
		const r2 = record(s2);
		expect(r1.ended).toEqual([{ reason: "preempted", by: "Obsidian Test" }]);
		const n1 = r1.words.length;
		await waitFor(() => r2.words.length > 2, 10_000, "s2 words");
		expect(r1.words.length).toBe(n1);
		expect(r1.ended).toHaveLength(1);
		expect((s2.token ?? 0) > (s1.token ?? 0)).toBe(true);
		await s2.stop();
	});

	describe("hotkey routing", () => {
		let client: UnivocalClient;
		const requests: ReadRequest[] = [];
		const sessions: ReadingSession[] = [];
		let answer: ReadRequestHandler = () => ({ kind: "decline", reason: "other" });

		beforeAll(async () => {
			client = new UnivocalClient({
				connectDir: mock.dir,
				clientInfo: { id: "md.obsidian.plugin.univocal.hk", name: "Obsidian HK", version: "0.0.0" },
				capabilities: ["word-events", "sentence-events", "hotkey-target"],
				tokenStore: new InMemoryTokenStore(),
				isInstalled: async () => true,
			});
			client.onReadRequest((req) => {
				requests.push(req);
				return answer(req);
			});
			await client.connect();
			expect(await mock.ctl("frontmost", String(process.pid))).toContain(String(process.pid));
		});
		afterAll(() => client?.disconnect());

		async function stopAll() {
			for (const s of sessions.splice(0)) await s.stop();
		}

		it("answers with read{requestId}, honouring prefer and startOffset", async () => {
			const text = "First paragraph is skipped.\n\nSecond paragraph is read aloud.";
			const start = text.indexOf("Second");
			answer = (req) => ({
				kind: "read",
				text,
				options: { startOffset: req.prefer === "document" ? start : 0, title: "Note.md" },
				onSession: (s) => sessions.push(s),
			});
			const out = await mock.ctl("hotkey", "document");
			expect(out).toMatch(/^routed md\.obsidian\.plugin\.univocal\.hk .*accepted=false/);
			expect(requests[requests.length - 1]).toMatchObject({ trigger: "hotkey", prefer: "document" });
			await waitFor(() => sessions.length === 1, 2000, "onSession");
			const r = record(sessions[0]!);
			await waitFor(() => r.words.length > 0, 10_000, "hotkey words");
			expect(r.words[0]!.start).toBeGreaterThanOrEqual(start);
			await stopAll();
		});

		it("accept → readAccepted then read", async () => {
			answer = () => ({
				kind: "accept",
				produce: async () => {
					await sleep(100);
					return { text: "Produced asynchronously after accepting." };
				},
				onSession: (s) => sessions.push(s),
			});
			const out = await mock.ctl("hotkey", "selection");
			expect(out).toMatch(/^routed .*accepted=true/);
			await waitFor(() => sessions.length === 1, 2000, "onSession");
			await stopAll();
		});

		it("decline → the server falls back", async () => {
			answer = () => ({ kind: "decline", reason: "noContent", detail: "test" });
			expect(await mock.ctl("hotkey", "document")).toMatch(/^fell back/);
			answer = () => ({ kind: "accept", produce: async () => null });
			expect(await mock.ctl("hotkey", "document")).toMatch(/^fell back/);
		});

		it("a too-late read (unknownRequest) is cleared silently", async () => {
			const errors: unknown[] = [];
			const off = client.on("error", (e) => errors.push(e));
			answer = () => ({
				kind: "accept",
				produce: async () => {
					await sleep(1800); // past acceptedMs (1500)
					return { text: "Too late to be read." };
				},
				onSession: (s) => sessions.push(s),
			});
			expect(await mock.ctl("hotkey", "document")).toMatch(/^fell back/);
			await sleep(400);
			expect(sessions).toHaveLength(0);
			expect(errors).toHaveLength(0);
			expect(client.state.kind).toBe("connected");
			off();
		});
	});

	it("consent denied by the user rejects with consentDenied{user}", async () => {
		const denyMock = await startMock({ consent: "deny" });
		try {
			const client = track(makeClient(denyMock));
			const err = await client.connect().catch((e: unknown) => e);
			expect(err).toBeInstanceOf(UnivocalError);
			expect((err as UnivocalError).connectError).toEqual({ code: "consentDenied", reason: "user" });
			expect(client.state).toMatchObject({ kind: "disconnected", error: { code: "consentDenied", reason: "user" } });
		} finally {
			await denyMock.stop();
		}
	});

	it("reconnects quietly (hello{quiet}) after the connection drops", async () => {
		const m = await startMock();
		try {
			const store = new InMemoryTokenStore();
			const client = track(
				new UnivocalClient({
					connectDir: m.dir,
					clientInfo: { id: "test.reconnect", name: "Reconnect", version: "0" },
					capabilities: ["word-events"],
					tokenStore: store,
					isInstalled: async () => true,
					reconnectDelaysMs: [100, 200, 400],
					pollIntervalMs: 200,
				}),
			);
			await client.connect();
			await client.whenIdle();
			expect(store.tokens.has(key(m))).toBe(true);
			const kinds: string[] = [];
			client.on("connection", (s) => kinds.push(s.kind));
			// The mock keeps grants in memory (a restarted mock would quiet-deny), so drop the
			// socket instead; server restarts are covered by the unit tests.
			(client as unknown as { link: { socket: { destroy(): void } } }).link.socket.destroy();
			await waitFor(() => kinds.includes("disconnected") && client.state.kind === "connected", 5000, "reconnected");
		} finally {
			await m.stop();
		}
	});
});
