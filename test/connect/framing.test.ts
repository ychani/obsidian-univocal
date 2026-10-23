import { describe, expect, it } from "vitest";
import { chunkText, utf8Length } from "../../src/connect/chunking";
import { UnivocalError } from "../../src/connect/errors";
import { encodeFrame, NdjsonDecoder, type WireMessage } from "../../src/connect/ndjson";

function decoder(max?: number) {
	const messages: WireMessage[] = [];
	const malformed: number[] = [];
	const overflow: number[] = [];
	const d = new NdjsonDecoder({ message: (m) => messages.push(m), malformed: (n) => malformed.push(n), overflow: (n) => overflow.push(n) }, max);
	return { d, messages, malformed, overflow };
}

describe("NDJSON decoder", () => {
	it("splits frames across arbitrary chunk boundaries, including inside a multi-byte character", () => {
		const { d, messages } = decoder();
		const bytes = Buffer.from('{"type":"word","t":"héllo 👋"}\n{"type":"ok","id":1}\n', "utf8");
		for (let i = 0; i < bytes.length; i++) d.push(bytes.subarray(i, i + 1));
		expect(messages).toEqual([
			{ type: "word", t: "héllo 👋" },
			{ type: "ok", id: 1 },
		]);
	});

	it("tolerates \\r\\n and blank lines; several frames per chunk", () => {
		const { d, messages } = decoder();
		d.push('{"type":"a"}\r\n\r\n\n{"type":"b"}\n{"type":"c"}');
		expect(messages.map((m) => m.type)).toEqual(["a", "b"]);
		d.push("\n");
		expect(messages.map((m) => m.type)).toEqual(["a", "b", "c"]);
	});

	it("skips malformed lines and non-objects without losing sync", () => {
		const { d, messages, malformed } = decoder();
		d.push('{not json}\n[1,2]\n"str"\n{"no":"type"}\n{"type":"ok"}\n');
		expect(messages).toEqual([{ type: "ok" }]);
		expect(malformed).toHaveLength(4);
	});

	it("reports an oversize line once and stops", () => {
		const { d, messages, overflow } = decoder(32);
		d.push('{"type":"ok"}\n');
		d.push(`{"type":"x","pad":"${"a".repeat(40)}`);
		expect(overflow).toHaveLength(1);
		d.push('"}\n{"type":"ok"}\n');
		expect(messages).toHaveLength(1);
	});

	it("an oversize line that arrives complete is also refused", () => {
		const { d, overflow } = decoder(32);
		d.push(`{"type":"x","pad":"${"a".repeat(40)}"}\n`);
		expect(overflow).toHaveLength(1);
	});
});

describe("encodeFrame", () => {
	it("is one line: raw newlines inside strings are escaped", () => {
		const f = encodeFrame({ type: "read", text: "a\nb\r\nc " });
		expect(f.indexOf(0x0a)).toBe(f.length - 1);
		expect(JSON.parse(f.toString("utf8"))).toEqual({ type: "read", text: "a\nb\r\nc " });
	});

	it("refuses frames over the limit with textTooLarge", () => {
		expect(() => encodeFrame({ type: "read", sessionId: "S", text: "x".repeat(100) }, 50)).toThrow(UnivocalError);
		try {
			encodeFrame({ type: "read", sessionId: "S", text: "x".repeat(100) }, 50);
		} catch (e) {
			expect((e as UnivocalError).code).toBe("textTooLarge");
			expect((e as UnivocalError).sessionId).toBe("S");
		}
	});
});

describe("chunkText", () => {
	it("returns the text unchanged when it fits", () => {
		expect(chunkText("short", 100)).toEqual(["short"]);
	});

	it("cuts right after \\n\\n, concatenates to the input, respects the byte budget", () => {
		const para = "Lorem ipsum dolor sit amet. ".repeat(10).trim();
		const text = Array.from({ length: 50 }, () => para).join("\n\n");
		const pieces = chunkText(text, 1000);
		expect(pieces.length).toBeGreaterThan(1);
		expect(pieces.join("")).toBe(text);
		for (const p of pieces) expect(utf8Length(p)).toBeLessThanOrEqual(1000);
		for (const p of pieces.slice(0, -1)) expect(p.endsWith("\n\n")).toBe(true);
	});

	it("falls back to \\n, then space, then a hard cut", () => {
		expect(chunkText("aaaa\nbbbb\ncccc", 11)).toEqual(["aaaa\nbbbb\n", "cccc"]);
		expect(chunkText("aaaa bbbb cccc", 11)).toEqual(["aaaa bbbb ", "cccc"]);
		expect(chunkText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
	});

	it("never splits a surrogate pair or a multi-byte character", () => {
		const text = "😀".repeat(100) + "é".repeat(100) + "한".repeat(100);
		const pieces = chunkText(text, 10);
		expect(pieces.join("")).toBe(text);
		for (const p of pieces) {
			expect(utf8Length(p)).toBeLessThanOrEqual(10);
			expect(Buffer.from(p, "utf8").toString("utf8")).toBe(p); // no lone surrogates
		}
	});

	it("handles a 2 MiB note at the default 512 KiB budget", () => {
		const text = ("Paragraph text here, with words. ".repeat(30) + "\n\n").repeat(2200);
		const pieces = chunkText(text);
		expect(pieces.join("")).toBe(text);
		expect(pieces.length).toBeGreaterThanOrEqual(4);
		for (const p of pieces) expect(utf8Length(p)).toBeLessThanOrEqual(512 * 1024);
	});
});
