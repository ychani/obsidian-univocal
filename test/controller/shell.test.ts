import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DevStatus } from "../../src/controller";
import { DEV_STATUS_FILE, devProtocolHandler, parseDevCommand, runDevCommand } from "../../src/devProtocol";
import { statusBarModel } from "../../src/statusBar";

describe("statusBarModel", () => {
	it("hides while idle", () => {
		expect(statusBarModel({ kind: "idle" }).visible).toBe(false);
	});
	it.each([
		[{ kind: "notInstalled" } as const, ["Get Univocal"], ["getUnivocal"]],
		[{ kind: "notRunning" } as const, ["Univocal off"], ["launchUnivocal"]],
		[{ kind: "consentPending" } as const, ["Waiting for approval in Univocal…"], ["stop"]],
		[{ kind: "denied", message: "x" } as const, ["Not allowed"], ["openSettings"]],
		[{ kind: "playing" } as const, ["⏸", "■"], ["pauseResume", "stop"]],
		[{ kind: "paused" } as const, ["⏵", "■"], ["pauseResume", "stop"]],
		[{ kind: "failed", message: "boom" } as const, ["Univocal ⚠"], ["read"]],
	])("%o", (state, labels, actions) => {
		const m = statusBarModel(state);
		expect(m.visible).toBe(true);
		expect(m.buttons.map((b) => b.label)).toEqual(labels);
		expect(m.buttons.map((b) => b.action)).toEqual(actions);
	});
});

describe("dev protocol", () => {
	it("parses commands", () => {
		expect(parseDevCommand({ action: "univocal-dev", cmd: "read" })).toEqual({ cmd: "read" });
		expect(parseDevCommand({ cmd: "read", prefer: "document" })).toEqual({ cmd: "read", prefer: "document" });
		expect(parseDevCommand({ cmd: "read", prefer: "bogus" })).toEqual({ cmd: "read" });
		expect(parseDevCommand({ cmd: "pause" })).toEqual({ cmd: "pause" });
		expect(parseDevCommand({ cmd: "stop" })).toEqual({ cmd: "stop" });
		expect(parseDevCommand({ cmd: "status", tag: "t1" })).toEqual({ cmd: "status", tag: "t1" });
		expect(parseDevCommand({ cmd: "rm -rf" })).toBeNull();
	});

	const status: DevStatus = {
		state: "playing",
		message: null,
		sessionId: "s1",
		lastWord: { start: 1, end: 2 },
		lastSentence: { start: 0, end: 9 },
		painted: { word: 1, sentence: 1 },
		mode: "reading",
		note: "a.md",
		connection: "connected",
		server: null,
		updatedAt: "now",
	};

	function deps(dir: string, enabled = true) {
		return {
			isEnabled: () => enabled,
			connectDir: () => dir,
			read: vi.fn(),
			pauseResume: vi.fn(),
			stop: vi.fn(),
			status: () => status,
		};
	}

	it("status writes the JSON file into the connect dir", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "uco-"));
		try {
			const file = await runDevCommand({ cmd: "status", tag: "q" }, deps(dir));
			expect(file).toBe(path.join(dir, DEV_STATUS_FILE));
			const json = JSON.parse(readFileSync(path.join(dir, DEV_STATUS_FILE), "utf8"));
			expect(json).toMatchObject({ state: "playing", sessionId: "s1", painted: { word: 1, sentence: 1 }, mode: "reading", tag: "q" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("routes read/pause/stop and is inert unless developer mode is on", () => {
		const on = deps("/nonexistent");
		const handler = devProtocolHandler(on);
		handler({ action: "univocal-dev", cmd: "read", prefer: "selection" });
		handler({ action: "univocal-dev", cmd: "pause" });
		handler({ action: "univocal-dev", cmd: "stop" });
		expect(on.read).toHaveBeenCalledWith("selection");
		expect(on.pauseResume).toHaveBeenCalledTimes(1);
		expect(on.stop).toHaveBeenCalledTimes(1);

		const off = deps("/nonexistent", false);
		devProtocolHandler(off)({ action: "univocal-dev", cmd: "read" });
		expect(off.read).not.toHaveBeenCalled();
	});
});
