import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReadRequestAnswer } from "../../src/connect/index";
import { remapOffset, sentenceStartBefore } from "../../src/controller";
import { SERVER, flush, rig } from "./fakes";

describe("read (command)", () => {
	it("connects, reads from the first visible offset and follows session states", async () => {
		const r = rig();
		r.note.firstVisible = 10;
		await r.controller.read();
		expect(r.client.connect).toHaveBeenCalledWith({ launch: true });
		expect(r.client.readCalls).toHaveLength(1);
		expect(r.client.readCalls[0]?.text).toBe(r.note.text);
		expect(r.client.readCalls[0]?.opts).toMatchObject({ startOffset: 10, rate: 1.25, title: "Note" });
		expect(r.controller.state.kind).toBe("loading");
		r.client.lastSession.emit("state", { state: "playing" });
		expect(r.controller.state.kind).toBe("playing");
		r.client.lastSession.emit("state", { state: "paused" });
		expect(r.controller.state.kind).toBe("paused");
		expect(r.states.slice(0, 3)).toEqual(["connecting", "loading", "playing"]);
	});

	it("starts at the selection when there is one", async () => {
		const r = rig();
		r.note.firstVisible = 10;
		r.note.selection = 20;
		await r.controller.read();
		expect(r.client.readCalls[0]?.opts.startOffset).toBe(20);
	});

	it("skips connect when already connected", async () => {
		const r = rig();
		r.client.connected();
		await r.controller.read();
		expect(r.client.connect).not.toHaveBeenCalled();
		expect(r.client.readCalls).toHaveLength(1);
	});

	it("needs an open, non-empty note", async () => {
		const r = rig();
		r.host.note = null;
		await r.controller.read();
		expect(r.notices).toEqual(["Open a note to read it aloud."]);
		r.host.note = r.note;
		r.note.text = "  \n\n ";
		await r.controller.read();
		expect(r.notices[1]).toBe("This note has nothing to read.");
		expect(r.client.connect).not.toHaveBeenCalled();
		expect(r.controller.state.kind).toBe("idle");
	});

	it("sends more:true when the reading view is still virtualised", async () => {
		const r = rig("Para one.\n\nPara two.", "reading");
		r.note.complete = false;
		await r.controller.read();
		expect(r.client.readCalls[0]?.opts.more).toBe(true);
	});

	it("re-maps the start when the note was edited while connecting", async () => {
		const r = rig("Alpha. Beta. Gamma.");
		r.note.firstVisible = 13; // "Gamma."
		let release!: () => void;
		r.client.connectImpl = () =>
			new Promise((resolve) => {
				release = () => {
					r.client.connected();
					resolve(SERVER);
				};
			});
		const p = r.controller.read();
		await flush();
		r.note.text = "Intro. Alpha. Beta. Gamma.";
		r.note.change("edited");
		release();
		await p;
		expect(r.client.readCalls[0]?.text).toBe("Intro. Alpha. Beta. Gamma.");
		expect(r.client.readCalls[0]?.opts.startOffset).toBe(20);
	});
});

describe("connect failures", () => {
	it.each([
		[{ code: "notInstalled" }, "notInstalled"],
		[{ code: "notRunning" }, "notRunning"],
		[{ code: "consentDenied", reason: "user" }, "denied"],
		[{ code: "consentDenied", reason: "timeout" }, "denied"],
		[{ code: "unauthorized" }, "denied"],
		[{ code: "unsupportedVersion" }, "failed"],
		[{ code: "transport", message: "boom" }, "failed"],
	])("%o → %s", async (error, kind) => {
		const r = rig();
		r.client.connectImpl = async () => {
			throw error;
		};
		await r.controller.read();
		expect(r.controller.state.kind).toBe(kind);
		expect(r.notices).toHaveLength(1);
		expect(r.client.readCalls).toHaveLength(0);
		expect(r.registry.paintedWords()).toHaveLength(0);
	});

	it("shows consentPending while Univocal asks", async () => {
		const r = rig();
		r.controller.start();
		let release!: () => void;
		r.client.connectImpl = () =>
			new Promise((resolve) => {
				r.client.setConnection({ kind: "connecting" });
				r.client.setConnection({ kind: "awaitingConsent" });
				r.client.events.emit("consent", { kind: "pending", requestId: "c1", timeoutSeconds: 60 });
				release = () => {
					r.client.setConnection({ kind: "connected", server: SERVER, capabilities: [], limits: { maxFrameBytes: 1, maxTextBytes: 1, rate: { min: 1, max: 1 } } });
					resolve(SERVER);
				};
			});
		const p = r.controller.read();
		await flush();
		expect(r.controller.state.kind).toBe("consentPending");
		release();
		await p;
		expect(r.controller.state.kind).toBe("loading");
		expect(r.client.readCalls).toHaveLength(1);
	});
});

describe("session lifecycle", () => {
	it("pause/resume and stop", async () => {
		const r = rig();
		await r.controller.read();
		const s = r.client.lastSession;
		s.emit("state", { state: "playing" });
		await r.controller.pauseResume();
		expect(s.pause).toHaveBeenCalled();
		expect(r.controller.state.kind).toBe("paused");
		await r.controller.pauseResume();
		expect(s.resume).toHaveBeenCalled();
		expect(r.controller.state.kind).toBe("playing");
		s.sentence(0, 9);
		s.word(0, 3);
		expect(r.registry.paintedWords()).toHaveLength(1);
		r.controller.stop();
		expect(s.stop).toHaveBeenCalled();
		expect(r.controller.state.kind).toBe("idle");
		expect(r.registry.paintedWords()).toHaveLength(0);
		expect(r.registry.paintedSentences()).toHaveLength(0);
	});

	it.each([
		["finished", "idle", 0],
		["stopped", "idle", 0],
		["preempted", "idle", 0],
		["revoked", "denied", 1],
	] as const)("ended{%s} → %s and clears", async (reason, kind, notices) => {
		const r = rig();
		await r.controller.read();
		const s = r.client.lastSession;
		s.sentence(0, 9);
		s.word(0, 3);
		s.emit("ended", { reason });
		expect(r.controller.state.kind).toBe(kind);
		expect(r.notices).toHaveLength(notices);
		expect(r.registry.paintedWords()).toHaveLength(0);
		expect(r.registry.all.every((h) => h.disposed)).toBe(true);
	});

	it("ended{error} reports the last session error", async () => {
		const r = rig();
		await r.controller.read();
		const s = r.client.lastSession;
		s.emit("error", { code: "engineError", message: "x", fatal: false });
		s.emit("ended", { reason: "error" });
		expect(r.controller.state).toEqual({ kind: "failed", message: "Univocal couldn't read this note" });
		expect(r.notices).toEqual(["Univocal couldn't read this note"]);
	});

	it("rate changes go to the live session", async () => {
		const r = rig();
		await r.controller.read();
		r.controller.rateChanged(2);
		expect(r.client.lastSession.setRate).toHaveBeenCalledWith(2);
	});
});

describe("highlight invariant: exactly one word range", () => {
	it("after N word events in one session", async () => {
		const r = rig();
		await r.controller.read();
		const s = r.client.lastSession;
		s.sentence(0, 9);
		for (let i = 0; i < 25; i++) s.word(i, i + 1);
		expect(r.registry.paintedWords()).toEqual([{ start: 24, end: 25 }]);
		expect(r.registry.paintedSentences()).toEqual([{ start: 0, end: 9 }]);
		s.sentence(10, 19);
		expect(r.registry.paintedWords()).toHaveLength(0);
		expect(r.registry.paintedSentences()).toEqual([{ start: 10, end: 19 }]);
	});

	it("across sessions, with late events from the old one dropped", async () => {
		const r = rig();
		await r.controller.read();
		const first = r.client.lastSession;
		first.sentence(0, 9);
		first.word(0, 3);
		await r.controller.read();
		const second = r.client.lastSession;
		expect(second).not.toBe(first);
		expect(first.stop).toHaveBeenCalled();
		// Late events from the first session must not paint.
		first.word(4, 8);
		first.sentence(10, 19);
		expect(r.registry.paintedWords()).toHaveLength(0);
		second.sentence(20, 29);
		for (let i = 20; i < 30; i++) {
			second.word(i, i + 1);
			first.word(i, i + 2);
		}
		expect(r.registry.paintedWords()).toEqual([{ start: 29, end: 30 }]);
		expect(r.registry.paintedSentences()).toEqual([{ start: 20, end: 29 }]);
		first.emit("ended", { reason: "preempted" });
		expect(r.controller.state.kind).not.toBe("idle");
	});

	it("drops events after stop", async () => {
		const r = rig();
		await r.controller.read();
		const s = r.client.lastSession;
		r.controller.stop();
		s.sentence(0, 9);
		s.word(0, 3);
		s.emit("state", { state: "playing" });
		expect(r.registry.paintedWords()).toHaveLength(0);
		expect(r.controller.state.kind).toBe("idle");
	});
});

describe("clear-on-events wiring", () => {
	it("workspace changes clear; the next word repaints word and sentence", async () => {
		const r = rig();
		await r.controller.read();
		const s = r.client.lastSession;
		s.sentence(0, 9);
		s.word(0, 3);
		r.controller.workspaceChanged();
		expect(r.registry.paintedWords()).toHaveLength(0);
		expect(r.registry.paintedSentences()).toHaveLength(0);
		s.word(4, 8);
		expect(r.registry.paintedWords()).toEqual([{ start: 4, end: 8 }]);
		expect(r.registry.paintedSentences()).toEqual([{ start: 0, end: 9 }]);
	});

	it("repeated identical word after a clear still repaints", async () => {
		const r = rig();
		await r.controller.read();
		const s = r.client.lastSession;
		s.sentence(0, 9);
		s.word(0, 3);
		r.controller.workspaceChanged();
		s.word(0, 3);
		expect(r.registry.paintedWords()).toEqual([{ start: 0, end: 3 }]);
	});

	it("a note switch (note no longer alive) stops", async () => {
		const r = rig();
		await r.controller.read();
		const s = r.client.lastSession;
		s.word(0, 3);
		r.note.alive = false;
		r.controller.workspaceChanged();
		expect(s.stop).toHaveBeenCalled();
		expect(r.controller.state.kind).toBe("idle");
		expect(r.registry.paintedWords()).toHaveLength(0);
		expect(r.note.listenerCount).toBe(0);
	});

	describe("edits", () => {
		beforeEach(() => vi.useFakeTimers());
		afterEach(() => vi.useRealTimers());

		it("restart from the re-mapped sentence after a debounce", async () => {
			const r = rig("A one. B two. C three.");
			await r.controller.read();
			const s = r.client.lastSession;
			s.emit("state", { state: "playing" });
			s.sentence(14, 22);
			s.word(14, 15);
			r.note.text = "X A one. B two. C three.";
			r.note.change("edited");
			expect(r.registry.paintedWords()).toHaveLength(0);
			r.note.change("edited");
			expect(r.client.readCalls).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(300);
			expect(s.stop).toHaveBeenCalled();
			expect(r.client.readCalls).toHaveLength(2);
			expect(r.client.readCalls[1]?.text).toBe("X A one. B two. C three.");
			expect(r.client.readCalls[1]?.opts.startOffset).toBe(16);
			// Old session's late word is dropped; the new one paints.
			s.word(14, 15);
			expect(r.registry.paintedWords()).toHaveLength(0);
			r.client.lastSession.word(16, 17);
			expect(r.registry.paintedWords()).toEqual([{ start: 16, end: 17 }]);
		});

		it("while paused, restart only on resume", async () => {
			const r = rig("A one. B two. C three.");
			await r.controller.read();
			const s = r.client.lastSession;
			s.emit("state", { state: "paused" });
			s.sentence(7, 13);
			r.note.text = "A one. B two! C three.";
			r.note.change("edited");
			await vi.advanceTimersByTimeAsync(1000);
			expect(r.client.readCalls).toHaveLength(1);
			await r.controller.pauseResume();
			expect(s.resume).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(0);
			expect(r.client.readCalls).toHaveLength(2);
			expect(r.client.readCalls[1]?.opts.startOffset).toBe(7);
		});
	});

	it("reading view re-render with the same text swaps the map and repaints", async () => {
		const r = rig("Para one.\n\nPara two.", "reading");
		await r.controller.read();
		const s = r.client.lastSession;
		s.sentence(0, 9);
		s.word(5, 8);
		r.note.change("rerendered");
		expect(r.client.readCalls).toHaveLength(1);
		expect(r.registry.paintedWords()).toEqual([{ start: 5, end: 8 }]);
		expect(r.registry.paintedSentences()).toEqual([{ start: 0, end: 9 }]);
		expect(r.registry.all.filter((h) => !h.disposed)).toHaveLength(1);
	});

	it("reading view rendering more sections appends them", async () => {
		const r = rig("Para one.", "reading");
		r.note.complete = false;
		await r.controller.read();
		const s = r.client.lastSession;
		r.note.text = "Para one.\n\nPara two.";
		r.note.complete = true;
		r.note.change("rerendered");
		expect(r.client.append).toHaveBeenCalledWith(s, "\n\nPara two.", false);
		expect(r.client.readCalls).toHaveLength(1);
	});

	it("reading view re-render with changed text restarts", async () => {
		const r = rig("Para one.\n\nPara two.", "reading");
		await r.controller.read();
		const s = r.client.lastSession;
		s.emit("state", { state: "playing" });
		s.sentence(11, 20);
		r.note.text = "Para 1.\n\nPara two.";
		r.note.change("rerendered");
		await flush();
		expect(s.stop).toHaveBeenCalled();
		expect(r.client.readCalls[1]?.opts.startOffset).toBe(9);
	});
});

describe("readRequest (hotkey routing)", () => {
	function decline(a: ReadRequestAnswer): string | null {
		return a.kind === "decline" ? a.reason : null;
	}

	it("registers the handler on start", () => {
		const r = rig();
		expect(r.client.readHandler).toBeUndefined();
		r.controller.start();
		expect(r.client.readHandler).toBeDefined();
	});

	it("declines notFocused without a MarkdownView", () => {
		const r = rig();
		r.controller.start();
		r.host.note = null;
		expect(decline(r.client.request())).toBe("notFocused");
	});

	it("declines notFocused when this window lacks focus (two vaults)", () => {
		const r = rig();
		r.controller.start();
		r.host.focused = false;
		expect(decline(r.client.request())).toBe("notFocused");
	});

	it("declines userDisabled when routing is off", () => {
		const r = rig();
		r.controller.start();
		r.settings.hotkeyRouting = false;
		expect(decline(r.client.request())).toBe("userDisabled");
	});

	it("declines noContent for an empty note", () => {
		const r = rig(" \n");
		r.controller.start();
		expect(decline(r.client.request())).toBe("noContent");
		expect(r.controller.state.kind).toBe("idle");
	});

	it("declines busy while a user-started read is connecting", async () => {
		const r = rig();
		r.controller.start();
		r.client.connectImpl = () => new Promise(() => {});
		void r.controller.read();
		await flush();
		expect(decline(r.client.request())).toBe("busy");
	});

	it("editor: answers read directly with the text and the selection start", () => {
		const r = rig("Alpha. Beta.");
		r.controller.start();
		r.note.selection = 7;
		r.note.firstVisible = 0;
		const a = r.client.request({ prefer: "selection" });
		expect(a.kind).toBe("read");
		if (a.kind !== "read") return;
		expect(a.text).toBe("Alpha. Beta.");
		expect(a.options?.startOffset).toBe(7);
		expect(r.controller.state.kind).toBe("loading");
	});

	it("prefer:document ignores the selection", () => {
		const r = rig("Alpha. Beta.");
		r.controller.start();
		r.note.selection = 7;
		r.note.firstVisible = 3;
		const a = r.client.request({ prefer: "document" });
		expect(a.kind === "read" && a.options?.startOffset).toBe(3);
	});

	it("the answered session drives highlights", async () => {
		const r = rig("Alpha. Beta.");
		r.controller.start();
		const a = r.client.request();
		if (a.kind !== "read") throw new Error("expected read");
		const s = await r.client.read(a.text, a.options);
		a.onSession?.(s as never);
		r.client.lastSession.emit("state", { state: "playing" });
		r.client.lastSession.sentence(0, 6);
		r.client.lastSession.word(0, 5);
		expect(r.controller.state.kind).toBe("playing");
		expect(r.registry.paintedWords()).toEqual([{ start: 0, end: 5 }]);
	});

	it("reading view: accepts, then produces the text", async () => {
		const r = rig("Para one.\n\nPara two.", "reading");
		r.controller.start();
		r.note.firstVisible = 11;
		const a = r.client.request({ prefer: "document" });
		expect(a.kind).toBe("accept");
		if (a.kind !== "accept") return;
		const produced = await a.produce();
		expect(produced?.text).toBe("Para one.\n\nPara two.");
		expect(produced?.options?.startOffset).toBe(11);
	});

	it("a hotkey request replaces our own running session", async () => {
		const r = rig();
		r.controller.start();
		await r.controller.read();
		const s = r.client.lastSession;
		s.word(0, 3);
		const a = r.client.request();
		expect(a.kind).toBe("read");
		expect(s.stop).toHaveBeenCalled();
		s.word(4, 8);
		expect(r.registry.paintedWords()).toHaveLength(0);
	});

	it("a session arriving after the user moved on is stopped", async () => {
		const r = rig();
		r.controller.start();
		const a = r.client.request();
		if (a.kind !== "read") throw new Error("expected read");
		r.controller.stop();
		const s = await r.client.read(a.text, a.options);
		a.onSession?.(s as never);
		expect(s.stop).toHaveBeenCalled();
		expect(r.controller.state.kind).toBe("idle");
	});

	it("goes back to idle when the answered read never starts", async () => {
		vi.useFakeTimers();
		try {
			const r = rig();
			r.controller.start();
			r.client.request();
			expect(r.controller.state.kind).toBe("loading");
			await vi.advanceTimersByTimeAsync(3600);
			expect(r.controller.state.kind).toBe("idle");
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("connection", () => {
	it("start() checks availability and connects quietly", async () => {
		const r = rig();
		r.client.availabilityResult = "installed";
		r.controller.start();
		await flush();
		expect(r.controller.state.kind).toBe("notRunning");
		expect(r.client.connectQuietly).toHaveBeenCalledTimes(1);
		expect(r.client.connect).not.toHaveBeenCalled();
	});

	it("reports notInstalled", async () => {
		const r = rig();
		r.client.availabilityResult = "notInstalled";
		r.controller.start();
		await flush();
		expect(r.controller.state.kind).toBe("notInstalled");
	});

	it("reconnects quietly with 1/2/4 s backoff after a drop", async () => {
		vi.useFakeTimers();
		try {
			const r = rig();
			r.controller.start();
			await vi.advanceTimersByTimeAsync(0);
			r.client.connectQuietly.mockClear();
			r.client.setConnection({ kind: "connected", server: SERVER, capabilities: [], limits: { maxFrameBytes: 1, maxTextBytes: 1, rate: { min: 1, max: 1 } } });
			r.client.setConnection({ kind: "disconnected" });
			await vi.advanceTimersByTimeAsync(999);
			expect(r.client.connectQuietly).toHaveBeenCalledTimes(0);
			await vi.advanceTimersByTimeAsync(1);
			expect(r.client.connectQuietly).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(2000);
			expect(r.client.connectQuietly).toHaveBeenCalledTimes(2);
			await vi.advanceTimersByTimeAsync(4000);
			expect(r.client.connectQuietly).toHaveBeenCalledTimes(3);
			await vi.advanceTimersByTimeAsync(20000);
			expect(r.client.connectQuietly).toHaveBeenCalledTimes(3);
		} finally {
			vi.useRealTimers();
		}
	});

	it("a dropped connection mid-session fails and clears", async () => {
		const r = rig();
		r.controller.start();
		await r.controller.read();
		r.client.lastSession.word(0, 3);
		r.client.setConnection({ kind: "disconnected", error: { code: "transport", message: "eof" } });
		expect(r.controller.state.kind).toBe("failed");
		expect(r.registry.paintedWords()).toHaveLength(0);
		r.controller.dispose();
	});

	it("forget authorization disconnects and deletes the token", async () => {
		const r = rig();
		r.tokens.tokens.set("com.univocal.app", "t");
		await r.controller.read();
		await r.controller.forgetAuthorization();
		expect(r.client.disconnect).toHaveBeenCalled();
		expect(r.tokens.delete).toHaveBeenCalledWith("com.univocal.app");
		expect(r.tokens.tokens.size).toBe(0);
		expect(r.controller.state.kind).toBe("idle");
	});

	it("dispose stops the session, disconnects and unregisters", async () => {
		const r = rig();
		r.controller.start();
		await r.controller.read();
		const s = r.client.lastSession;
		r.controller.dispose();
		expect(s.stop).toHaveBeenCalled();
		expect(r.client.disconnect).toHaveBeenCalled();
		expect(r.client.readHandler).toBeUndefined();
		expect(r.registry.all.every((h) => h.disposed)).toBe(true);
	});
});

describe("devStatus", () => {
	it("reports state, session, last ranges, painted counts and mode", async () => {
		const r = rig();
		await r.controller.read();
		const s = r.client.lastSession;
		s.emit("state", { state: "playing" });
		s.sentence(0, 9);
		s.word(4, 8);
		const st = r.controller.devStatus();
		expect(st).toMatchObject({
			state: "playing",
			sessionId: s.id,
			lastWord: { start: 4, end: 8 },
			lastSentence: { start: 0, end: 9 },
			painted: { word: 1, sentence: 1 },
			mode: "live-preview",
			note: "Note.md",
		});
		expect(JSON.stringify(st)).not.toContain("fish");
	});
});

describe("remapOffset", () => {
	it("keeps offsets before the edit", () => {
		expect(remapOffset("Aa. Bb. Cc.", "Aa. Bb. Cc. Dd.", 4)).toBe(4);
	});
	it("shifts offsets after the edit", () => {
		expect(remapOffset("Aa. Bb. Cc.", "Zz. Aa. Bb. Cc.", 8)).toBe(12);
	});
	it("snaps to the sentence start around an edit inside the current sentence", () => {
		expect(remapOffset("Aa. Bb bb. Cc.", "Aa. Bb XX. Cc.", 4)).toBe(4);
	});
	it("sentenceStartBefore finds the boundary", () => {
		expect(sentenceStartBefore("One. Two three", 10, 300)).toBe(5);
		expect(sentenceStartBefore("Line\nnext", 7, 300)).toBe(5);
	});
});
