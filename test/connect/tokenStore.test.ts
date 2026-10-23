/**
 * Token stores with a stubbed `execFile` — these tests never run `security`
 * and never touch the real Keychain.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type ExecFileCallback,
	type ExecFileFn,
	FallbackTokenStore,
	FileTokenStore,
	InMemoryTokenStore,
	KeychainTokenStore,
	TokenStoreTimeoutError,
} from "../../src/connect/tokenStore";
import { shortTmpDir } from "./helpers/mock";

type Call = { file: string; args: string[] };

function stubExec(respond: (args: string[], cb: ExecFileCallback) => void) {
	const calls: Call[] = [];
	let killed = 0;
	const exec: ExecFileFn = (file, args, _opts, cb) => {
		calls.push({ file, args });
		respond(args, cb);
		return { kill: () => void killed++ };
	};
	return { exec, calls, killed: () => killed };
}

const exitWith = (code: number) => Object.assign(new Error(`exit ${code}`), { code });

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tmpFile() {
	const d = shortTmpDir("uct-");
	dirs.push(d);
	return path.join(d, "nested", "tokens.json");
}

describe("KeychainTokenStore (stubbed security CLI)", () => {
	it("reads with find-generic-password -s com.univocal.connect -a <bundle> -w", async () => {
		const s = stubExec((_a, cb) => cb(null, "uc1_abc\n", ""));
		const store = new KeychainTokenStore({ execFile: s.exec });
		expect(await store.get("com.univocal.app")).toBe("uc1_abc");
		expect(s.calls[0]).toEqual({
			file: "/usr/bin/security",
			args: ["find-generic-password", "-s", "com.univocal.connect", "-a", "com.univocal.app", "-w"],
		});
	});

	it("not found (exit 44) is null, not an error", async () => {
		const store = new KeychainTokenStore({ execFile: stubExec((_a, cb) => cb(exitWith(44), "", "not found")).exec });
		expect(await store.get("com.univocal.app")).toBeNull();
	});

	it("writes with add-generic-password -U … -w <token>; delete tolerates not found", async () => {
		const s = stubExec((args, cb) => cb(args[0] === "delete-generic-password" ? exitWith(44) : null, "", ""));
		const store = new KeychainTokenStore({ execFile: s.exec });
		await store.set("com.univocal.app", "uc1_t");
		await store.delete("com.univocal.app");
		const add = s.calls[0]!.args;
		expect(add.slice(0, 6)).toEqual(["add-generic-password", "-U", "-s", "com.univocal.connect", "-a", "com.univocal.app"]);
		expect(add.slice(-2)).toEqual(["-w", "uc1_t"]);
		expect(s.calls[1]!.args).toEqual(["delete-generic-password", "-s", "com.univocal.connect", "-a", "com.univocal.app"]);
	});

	it("times out quickly (and kills the child) when security hangs on a prompt", async () => {
		const s = stubExec(() => {
			/* never answers */
		});
		const store = new KeychainTokenStore({ execFile: s.exec, timeoutMs: 50 });
		const t0 = Date.now();
		await expect(store.get("com.univocal.app")).rejects.toBeInstanceOf(TokenStoreTimeoutError);
		expect(Date.now() - t0).toBeLessThan(1000);
		expect(s.killed()).toBe(1);
	});

	it("other failures reject", async () => {
		const store = new KeychainTokenStore({ execFile: stubExec((_a, cb) => cb(exitWith(51), "", "")).exec });
		await expect(store.get("x")).rejects.toThrow(/exited 51/);
		const throwing = new KeychainTokenStore({
			execFile: () => {
				throw new Error("spawn EACCES");
			},
		});
		await expect(throwing.get("x")).rejects.toThrow(/EACCES/);
	});
});

describe("FileTokenStore", () => {
	it("round-trips in a 0600 file inside a 0700 dir", async () => {
		const file = tmpFile();
		const store = new FileTokenStore(file);
		expect(await store.get("a")).toBeNull();
		await store.set("a", "uc1_a");
		await store.set("b", "uc1_b");
		expect(await store.get("a")).toBe("uc1_a");
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
		await store.delete("a");
		expect(await new FileTokenStore(file).get("a")).toBeNull();
		expect(await new FileTokenStore(file).get("b")).toBe("uc1_b");
	});

	it("a corrupt file reads as empty", async () => {
		const file = tmpFile();
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "{nope");
		expect(await new FileTokenStore(file).get("a")).toBeNull();
	});
});

describe("FallbackTokenStore (Keychain → file)", () => {
	it("keychain timeout on read → file token", async () => {
		const file = new FileTokenStore(tmpFile());
		await file.set("com.univocal.app", "uc1_file");
		const hang = new KeychainTokenStore({ execFile: stubExec(() => {}).exec, timeoutMs: 30 });
		const errors: string[] = [];
		const store = new FallbackTokenStore(hang, file, (op) => errors.push(op));
		expect(await store.get("com.univocal.app")).toBe("uc1_file");
		expect(errors).toEqual(["get"]);
	});

	it("keychain failure on write → file; keychain success → file copy removed", async () => {
		const file = new FileTokenStore(tmpFile());
		const broken = new KeychainTokenStore({ execFile: stubExec((_a, cb) => cb(exitWith(1), "", "")).exec });
		await new FallbackTokenStore(broken, file).set("k", "uc1_1");
		expect(await file.get("k")).toBe("uc1_1");

		const mem = new InMemoryTokenStore();
		await new FallbackTokenStore(mem, file).set("k", "uc1_2");
		expect(await mem.get("k")).toBe("uc1_2");
		expect(await file.get("k")).toBeNull();
	});

	it("delete clears both", async () => {
		const a = new InMemoryTokenStore({ k: "1" });
		const b = new InMemoryTokenStore({ k: "2" });
		await new FallbackTokenStore(a, b).delete("k");
		expect(a.tokens.size + b.tokens.size).toBe(0);
	});
});
