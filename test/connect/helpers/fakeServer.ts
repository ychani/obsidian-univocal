/**
 * A scriptable in-process Connect server for unit tests: a real Unix socket
 * plus `connect.json`, with every frame recorded so tests can assert the wire.
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { NdjsonDecoder, type WireMessage } from "../../../src/connect/ndjson";
import { shortTmpDir } from "./mock";

export const WELCOME = {
	type: "welcome",
	version: 1,
	server: { name: "Fake Univocal", version: "9.9.9", bundleId: "com.univocal.app" },
	capabilities: ["word-events", "sentence-events", "seek", "rate", "chunking", "voices", "hotkey-routing"],
	limits: { maxFrameBytes: 1_048_576, maxTextBytes: 8_388_608, rate: { min: 0.25, max: 4 } },
	grant: { clientId: "x", identity: "unverified:x" },
};

export class FakeConn {
	readonly received: WireMessage[] = [];
	private waiters: { type?: string; resolve(m: WireMessage): void }[] = [];
	private cursor = 0;
	closed = false;

	constructor(readonly socket: net.Socket) {
		const decoder = new NdjsonDecoder({ message: (m) => this.onMessage(m) }, 64 * 1024 * 1024);
		socket.on("data", (d: Buffer) => decoder.push(d));
		socket.on("close", () => (this.closed = true));
		socket.on("error", () => {});
	}

	private onMessage(m: WireMessage): void {
		this.received.push(m);
		this.pump();
	}

	private pump(): void {
		while (this.waiters.length > 0) {
			const w = this.waiters[0]!;
			let found = -1;
			for (let i = this.cursor; i < this.received.length; i++) {
				if (!w.type || this.received[i]!.type === w.type) {
					found = i;
					break;
				}
			}
			if (found === -1) return;
			this.cursor = found + 1;
			this.waiters.shift();
			w.resolve(this.received[found]!);
		}
	}

	/** Next received message (of `type`, skipping others) after the last one returned. */
	next(type?: string, timeoutMs = 3000): Promise<WireMessage> {
		return new Promise((resolve, reject) => {
			const t = setTimeout(() => reject(new Error(`timed out waiting for ${type ?? "a message"}`)), timeoutMs);
			this.waiters.push({
				type,
				resolve: (m) => {
					clearTimeout(t);
					resolve(m);
				},
			});
			this.pump();
		});
	}

	send(msg: Record<string, unknown>): void {
		this.socket.write(JSON.stringify(msg) + "\n");
	}

	sendRaw(raw: string | Buffer): void {
		this.socket.write(raw);
	}

	/** Answer the pending command `msg` with `ok`. */
	ok(msg: WireMessage): void {
		this.send({ type: "ok", id: msg.id, sessionId: msg.sessionId });
	}

	end(): void {
		this.socket.destroy();
	}
}

export class FakeServer {
	readonly dir: string;
	readonly socketPath: string;
	readonly conns: FakeConn[] = [];
	private server: net.Server;
	private connWaiters: ((c: FakeConn) => void)[] = [];
	/** Called for each new connection before tests see it (e.g. auto-welcome). */
	onConnection?: (c: FakeConn) => void;

	private constructor(dir: string) {
		this.dir = dir;
		this.socketPath = path.join(dir, "s.sock");
		this.server = net.createServer((socket) => {
			const c = new FakeConn(socket);
			this.conns.push(c);
			this.onConnection?.(c);
			this.connWaiters.shift()?.(c);
		});
	}

	static async start(opts: { discovery?: boolean; bundleId?: string } = {}): Promise<FakeServer> {
		const s = new FakeServer(shortTmpDir("ucf-"));
		await new Promise<void>((resolve, reject) => {
			s.server.once("error", reject);
			s.server.listen(s.socketPath, () => resolve());
		});
		if (opts.discovery !== false) s.writeDiscovery({ bundleId: opts.bundleId });
		return s;
	}

	writeDiscovery(opts: { pid?: number; bundleId?: string; versions?: number[]; socket?: string } = {}): void {
		const d = {
			protocol: "univocal-connect",
			versions: opts.versions ?? [1],
			socket: opts.socket ?? this.socketPath,
			pid: opts.pid ?? process.pid,
			server: { name: "Fake Univocal", version: "9.9.9", bundleId: opts.bundleId ?? "com.univocal.app" },
		};
		const tmp = path.join(this.dir, "connect.json.tmp");
		fs.writeFileSync(tmp, JSON.stringify(d), { mode: 0o600 });
		fs.renameSync(tmp, path.join(this.dir, "connect.json"));
	}

	removeDiscovery(): void {
		fs.rmSync(path.join(this.dir, "connect.json"), { force: true });
	}

	nextConnection(timeoutMs = 3000): Promise<FakeConn> {
		const already = this.conns.find((c) => !(c as unknown as { taken?: boolean }).taken);
		if (already) {
			(already as unknown as { taken?: boolean }).taken = true;
			return Promise.resolve(already);
		}
		return new Promise((resolve, reject) => {
			const t = setTimeout(() => reject(new Error("timed out waiting for a connection")), timeoutMs);
			this.connWaiters.push((c) => {
				clearTimeout(t);
				(c as unknown as { taken?: boolean }).taken = true;
				resolve(c);
			});
		});
	}

	/** Accept the next hello with `welcome` (optionally after consent). Returns the conn and its hello. */
	async acceptNext(opts: { consent?: string; welcome?: Record<string, unknown> } = {}): Promise<{ conn: FakeConn; hello: WireMessage }> {
		const conn = await this.nextConnection();
		const hello = await conn.next("hello");
		if (opts.consent) {
			conn.send({ type: "consentPending", requestId: "c1", timeoutSeconds: 120 });
			conn.send({ type: "consentGranted", requestId: "c1", token: opts.consent });
		}
		conn.send({ ...WELCOME, ...opts.welcome });
		return { conn, hello };
	}

	async close(): Promise<void> {
		for (const c of this.conns) c.end();
		await new Promise<void>((r) => this.server.close(() => r()));
		fs.rmSync(this.dir, { recursive: true, force: true });
	}
}
