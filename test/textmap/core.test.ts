import { describe, expect, it } from "vitest";
import {
	chunkText,
	entryIndexAt,
	exceedsUTF8,
	firstVisibleIndex,
	followScrollTop,
	remapOffset,
	sentenceStartBefore,
	separatorFor,
	slicesFor,
	snapToCodePoint,
	utf8Length,
} from "../../src/textmap/core";

describe("separatorFor", () => {
	it("tops up to n newlines and adds nothing at the start", () => {
		expect(separatorFor("", 2)).toBe("");
		expect(separatorFor("a", 2)).toBe("\n\n");
		expect(separatorFor("a\n", 2)).toBe("\n");
		expect(separatorFor("a\n\n", 2)).toBe("");
		expect(separatorFor("a", 1)).toBe("\n");
		expect(separatorFor("a\n", 1)).toBe("");
	});
});

describe("entryIndexAt / slicesFor", () => {
	const entries = [
		{ start: 0, length: 5 }, // "Hello"
		{ start: 7, length: 5 }, // after "\n\n"
		{ start: 12, length: 3 },
	];
	it("finds the last entry at or before an offset", () => {
		expect(entryIndexAt(entries, -1)).toBe(-1);
		expect(entryIndexAt(entries, 0)).toBe(0);
		expect(entryIndexAt(entries, 6)).toBe(0);
		expect(entryIndexAt(entries, 7)).toBe(1);
		expect(entryIndexAt(entries, 99)).toBe(2);
	});
	it("slices across entries and skips separators", () => {
		expect(slicesFor(entries, 3, 9)).toEqual([
			{ index: 0, start: 3, end: 5 },
			{ index: 1, start: 0, end: 2 },
		]);
		expect(slicesFor(entries, 5, 7)).toEqual([]);
		expect(slicesFor(entries, 10, 14)).toEqual([
			{ index: 1, start: 3, end: 5 },
			{ index: 2, start: 0, end: 2 },
		]);
		expect(slicesFor(entries, 4, 4)).toEqual([]);
	});
});

describe("remapOffset", () => {
	const old = "One. Two three. Four.";
	it("keeps offsets before the edit", () => {
		expect(remapOffset(old, old + " Five.", 5)).toBe(5);
	});
	it("shifts offsets after the edit", () => {
		expect(remapOffset(old, "Zero. " + old, 16)).toBe(22);
	});
	it("restarts at the sentence around an edit inside the current sentence", () => {
		const changed = "One. Two THREE. Four.";
		expect(remapOffset(old, changed, 5)).toBe(5);
		expect(sentenceStartBefore(changed, 9, 300)).toBe(5);
	});
	it("never lands inside a surrogate pair", () => {
		const a = "x 😀 y";
		const b = "x 😁 y";
		const r = remapOffset(a, b, 3);
		expect(r === 2 || r === 0).toBe(true);
		expect(snapToCodePoint("😀", 1)).toBe(0);
	});
});

describe("followScrollTop / firstVisibleIndex", () => {
	it("leaves a word inside the 25–75 % band alone", () => {
		expect(followScrollTop(300, 20, 0, 1000)).toBeNull();
		expect(followScrollTop(740, 20, 0, 1000)).toBeNull();
	});
	it("brings a word outside the band to 40 %", () => {
		expect(followScrollTop(900, 20, 100, 1000)).toBe(100 + 910 - 400);
		expect(followScrollTop(10, 20, 50, 1000)).toBe(0);
	});
	it("picks the first block whose top is on screen", () => {
		expect(firstVisibleIndex([-50, 10, 50], [-10, 40, 80], 100)).toBe(1);
		expect(firstVisibleIndex([-500], [500], 100)).toBe(0);
		expect(firstVisibleIndex([200], [300], 100)).toBe(-1);
	});
});

describe("UTF-8 limits and chunking", () => {
	it("counts UTF-8 bytes", () => {
		expect(utf8Length("aé日😀")).toBe(1 + 2 + 3 + 4);
		expect(exceedsUTF8("😀", 3)).toBe(true);
		expect(exceedsUTF8("😀", 4)).toBe(false);
		expect(exceedsUTF8("abc", 3)).toBe(false);
	});
	it("cuts at paragraph breaks under the limit and round-trips", () => {
		const para = "Sentence one. Sentence two.\n\n";
		const text = para.repeat(10);
		const chunks = chunkText(text, 100);
		expect(chunks.join("")).toBe(text);
		for (const c of chunks) {
			expect(utf8Length(c)).toBeLessThanOrEqual(100);
			expect(c.endsWith("\n\n") || c === chunks[chunks.length - 1]).toBe(true);
		}
	});
	it("never splits a surrogate pair", () => {
		const text = "😀".repeat(50);
		const chunks = chunkText(text, 10);
		expect(chunks.join("")).toBe(text);
		for (const c of chunks) {
			expect(utf8Length(c)).toBeLessThanOrEqual(10);
			expect(c.length % 2).toBe(0);
		}
	});
	it("returns one chunk when it fits", () => {
		expect(chunkText("short")).toEqual(["short"]);
		expect(chunkText("")).toEqual([]);
	});
});
