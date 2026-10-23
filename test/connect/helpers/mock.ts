/**
 * Spawns the real `univocal-mock serve` for integration tests. Each mock gets
 * its own short connect dir under /tmp/claude-501 (sun_path ≤ 103 bytes).
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const MOCK_BIN = process.env.UNIVOCAL_MOCK_BIN ?? "";
export const hasMock = MOCK_BIN !== "" && fs.existsSync(MOCK_BIN);

export interface Mock {
	dir: string;
	child: ChildProcess;
	output(): string;
	ctl(...args: string[]): Promise<string>;
	stop(): Promise<void>;
}

export function shortTmpDir(prefix = "uco-"): string {
	const base = "/tmp/claude-501";
	fs.mkdirSync(base, { recursive: true, mode: 0o700 });
	return fs.mkdtempSync(path.join(base, prefix));
}

export async function startMock(opts: { consent?: string; args?: string[] } = {}): Promise<Mock> {
	const dir = shortTmpDir();
	const args = ["serve", "--dir", dir, "--consent", opts.consent ?? "allow", ...(opts.args ?? [])];
	const child = spawn(MOCK_BIN, args, { stdio: ["pipe", "pipe", "pipe"] });
	let out = "";
	child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
	child.stderr?.on("data", (d: Buffer) => (out += d.toString()));
	const deadline = Date.now() + 10_000;
	for (;;) {
		try {
			const d = JSON.parse(fs.readFileSync(path.join(dir, "connect.json"), "utf8")) as { pid: number };
			if (d.pid === child.pid && fs.existsSync(path.join(dir, "mock-control.sock"))) break;
		} catch {
			/* not yet */
		}
		if (child.exitCode !== null) throw new Error(`univocal-mock exited early: ${out}`);
		if (Date.now() > deadline) {
			child.kill("SIGKILL");
			throw new Error(`univocal-mock did not start: ${out}`);
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	let stopped = false;
	return {
		dir,
		child,
		output: () => out,
		ctl: (...a: string[]) =>
			new Promise<string>((resolve, reject) => {
				execFile(MOCK_BIN, ["ctl", "--dir", dir, ...a], { timeout: 15_000, encoding: "utf8" }, (err, stdout, stderr) =>
					err ? reject(new Error(`ctl ${a.join(" ")} failed: ${err.message} ${stderr}`)) : resolve(String(stdout).trim()),
				);
			}),
		stop: async () => {
			if (stopped) return;
			stopped = true;
			if (child.exitCode === null && child.signalCode === null) {
				const exited = new Promise<void>((r) => child.once("exit", () => r()));
				child.kill("SIGINT");
				const t = setTimeout(() => child.kill("SIGKILL"), 2000);
				await exited;
				clearTimeout(t);
			}
			fs.rmSync(dir, { recursive: true, force: true });
		},
	};
}

export async function waitFor(cond: () => boolean, timeoutMs = 5000, what = "condition"): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 10));
	}
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
