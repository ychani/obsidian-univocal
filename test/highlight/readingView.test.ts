import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReadingViewHighlighter } from "../../src/highlight/readingView";
import { setHighlightStyle, UNDERLINE_STYLE_CLASS } from "../../src/highlight/style";
import type { ReadingViewHighlighterFactory } from "../../src/highlight/types";
import { createReadingViewTextMap, watchRendering } from "../../src/textmap/readingView";
import type { ReadingViewTextMap } from "../../src/textmap/types";
import { FakeHighlight, FakeHighlightRegistry, installFakeHighlightApi } from "./fakeHighlightApi";

const factory: ReadingViewHighlighterFactory = createReadingViewHighlighter;

const HTML =
	`<div class="el-p"><p>The quick brown fox jumps over the lazy dog. It was not amused.</p></div>` +
	`<div class="el-p"><p>Second <strong>bold</strong> paragraph with emoji 😀 and 日本語.</p></div>`;

function setup(): { root: HTMLElement; map: ReadingViewTextMap; words: [number, number][]; html: string } {
	document.body.innerHTML = `<div class="markdown-preview-view"><div class="markdown-preview-sizer">${HTML}</div></div>`;
	const root = document.querySelector<HTMLElement>(".markdown-preview-sizer")!;
	const map = createReadingViewTextMap(root);
	const words: [number, number][] = [];
	for (const m of map.text.matchAll(/[^\s.]+/gu)) words.push([m.index!, m.index! + m[0].length]);
	return { root, map, words, html: root.innerHTML };
}

/** 50 word events, cycling through the note's words, sentences alongside. */
function speak(h: ReturnType<typeof factory>, map: ReadingViewTextMap, words: [number, number][], count = 50): [number, number] {
	let last: [number, number] = [0, 0];
	const firstSentenceEnd = map.text.indexOf(".") + 1;
	for (let i = 0; i < count; i++) {
		const w = words[i % words.length]!;
		if (i % 10 === 0) h.setSentence(w[0] < firstSentenceEnd ? map.rangeFor(0, firstSentenceEnd) : map.rangeFor(w[0], map.text.length));
		h.setWord(map.rangeFor(w[0], w[1]));
		last = w;
	}
	return last;
}

describe("reading-view highlighter: CSS Custom Highlight API", () => {
	let api: ReturnType<typeof installFakeHighlightApi>;
	beforeEach(() => {
		api = installFakeHighlightApi();
	});
	afterEach(() => api.uninstall());

	const word = () => api.registry.get("univocal-word");
	const sentence = () => api.registry.get("univocal-sentence");

	it("uses CSS.highlights from the document's window", () => {
		setup();
		const h = factory(document);
		expect(h.mode).toBe("css-highlight");
		expect(word()).toBeInstanceOf(FakeHighlight);
		expect(sentence()).toBeInstanceOf(FakeHighlight);
		expect(word()!.priority).toBeGreaterThan(sentence()!.priority);
		h.dispose();
	});

	it("after 50 setWord calls exactly one word range is live (and it is the last one)", () => {
		const { map, words } = setup();
		const h = factory(document);
		const last = speak(h, map, words);
		expect(word()!.size).toBe(1);
		expect(sentence()!.size).toBe(1);
		expect(h.paintedRangeCount?.()).toEqual({ word: 1, sentence: 1 });
		const [only] = [...word()!] as Range[];
		expect(only!.toString()).toBe(map.text.slice(last[0], last[1]));
		// The registry holds one entry per name, never more.
		expect([...api.registry.keys()].sort()).toEqual(["univocal-sentence", "univocal-word"]);
		h.dispose();
	});

	it("a word spanning text nodes is one logical range (one Range per node), still replaced", () => {
		const { map } = setup();
		const h = factory(document);
		const i = map.text.indexOf("bold");
		h.setWord(map.rangeFor(i - 7, i + 4)); // "Second bold": two text nodes
		expect(word()!.size).toBe(2);
		h.setWord(map.rangeFor(0, 3));
		expect(word()!.size).toBe(1);
		h.setWord(null);
		expect(word()!.size).toBe(0);
		h.dispose();
	});

	it("clear() leaves zero ranges", () => {
		const { map, words } = setup();
		const h = factory(document);
		speak(h, map, words);
		h.clear();
		expect(word()!.size).toBe(0);
		expect(sentence()!.size).toBe(0);
		expect(h.paintedRangeCount?.()).toEqual({ word: 0, sentence: 0 });
		h.clear(); // idempotent
		expect(word()!.size).toBe(0);
		h.dispose();
	});

	it("dispose() deletes the registry entries and later calls are no-ops", () => {
		const { map, words } = setup();
		const h = factory(document);
		speak(h, map, words);
		h.dispose();
		expect(api.registry.has("univocal-word")).toBe(false);
		expect(api.registry.has("univocal-sentence")).toBe(false);
		expect(api.registry.size).toBe(0);
		h.setWord(map.rangeFor(0, 3));
		h.setSentence(map.rangeFor(0, 10));
		h.clear();
		h.dispose();
		expect(api.registry.size).toBe(0);
	});

	it("across two sessions nothing from session 1 remains", () => {
		const { map, words } = setup();
		const h = factory(document);
		speak(h, map, words.slice(0, 5), 20);
		const session1 = new Set<AbstractRange>([...word()!, ...sentence()!]);
		h.clear();
		const i = map.text.indexOf("Second");
		h.setSentence(map.rangeFor(i, map.text.length)); // three text nodes → three Ranges
		h.setWord(map.rangeFor(i, i + 6));
		expect(word()!.size).toBe(1);
		expect([...sentence()!].map((r) => (r as Range).toString()).join("")).toBe(map.text.slice(i).trimEnd());
		for (const r of [...word()!, ...sentence()!]) expect(session1.has(r)).toBe(false);
		expect(([...word()!][0] as Range).toString()).toBe("Second");
		h.dispose();
	});

	it("a new instance (plugin reload) replaces a stale one; the stale one's dispose leaves it alone", () => {
		const { map } = setup();
		const stale = factory(document);
		stale.setWord(map.rangeFor(0, 3));
		const fresh = factory(document);
		expect(word()!.size).toBe(0); // the stale painting is gone
		fresh.setWord(map.rangeFor(4, 9));
		stale.dispose();
		expect(word()!.size).toBe(1);
		expect(([...word()!][0] as Range).toString()).toBe("quick");
		fresh.dispose();
		expect(api.registry.size).toBe(0);
	});

	it("re-registers if something deleted its entry", () => {
		const { map } = setup();
		const h = factory(document);
		api.registry.delete("univocal-word");
		h.setWord(map.rangeFor(0, 3));
		expect(word()!.size).toBe(1);
		h.dispose();
	});

	it("falls back to <mark> when the window has no CSS.highlights", () => {
		api.uninstall();
		setup();
		expect(factory(document).mode).toBe("mark");
		api = installFakeHighlightApi();
		expect(factory(document, { forceFallback: true }).mode).toBe("mark");
	});

	it("the fake registry is faithful: it rejects non-Highlight values", () => {
		expect(() => new FakeHighlightRegistry().set("x", {} as FakeHighlight)).toThrow(TypeError);
	});
});

describe("reading-view highlighter: <mark> fallback", () => {
	beforeEach(() => {
		expect((window as unknown as { CSS?: { highlights?: unknown } }).CSS?.highlights).toBeUndefined();
	});

	const marks = (cls: string) => document.querySelectorAll(`mark.${cls}`);

	it("after 50 setWord calls exactly one word <mark> exists and the text is unchanged", () => {
		const { root, map, words } = setup();
		const h = factory(document);
		expect(h.mode).toBe("mark");
		const before = root.textContent;
		const last = speak(h, map, words);
		expect(marks("univocal-word")).toHaveLength(1);
		expect(h.paintedRangeCount?.().word).toBe(1);
		expect(marks("univocal-word")[0]!.textContent).toBe(map.text.slice(last[0], last[1]));
		expect(root.querySelectorAll("mark mark")).toHaveLength(0);
		expect(root.textContent).toBe(before);
		h.dispose();
	});

	it("clear() unwraps completely: same markup, same text nodes", () => {
		const { root, map, words, html } = setup();
		const nodes = map.entries.map((e) => e.node);
		const h = factory(document);
		speak(h, map, words);
		h.clear();
		expect(root.querySelectorAll("mark")).toHaveLength(0);
		expect(h.paintedRangeCount?.()).toEqual({ word: 0, sentence: 0 });
		expect(root.innerHTML).toBe(html);
		for (const n of nodes) expect(n.isConnected).toBe(true);
		h.dispose();
	});

	it("word inside the sentence: one mark carries both classes", () => {
		const { map } = setup();
		const h = factory(document);
		const end = map.text.indexOf(".") + 1;
		h.setSentence(map.rangeFor(0, end));
		h.setWord(map.rangeFor(4, 9));
		expect(marks("univocal-word")).toHaveLength(1);
		expect(marks("univocal-word")[0]!.className).toBe("univocal-sentence univocal-word");
		expect([...marks("univocal-sentence")].map((m) => m.textContent).join("")).toBe(map.text.slice(0, end));
		h.dispose();
	});

	it("across two sessions nothing from session 1 remains", () => {
		const { root, map, words, html } = setup();
		const h = factory(document);
		speak(h, map, words.slice(0, 5), 20);
		h.clear();
		expect(root.innerHTML).toBe(html);
		const i = map.text.indexOf("Second");
		h.setWord(map.rangeFor(i, i + 6));
		expect(marks("univocal-word")).toHaveLength(1);
		expect(marks("univocal-word")[0]!.textContent).toBe("Second");
		expect(marks("univocal-sentence")).toHaveLength(0);
		h.dispose();
		expect(root.innerHTML).toBe(html);
	});

	it("dispose() removes every mark and ignores later calls", () => {
		const { root, map, words, html } = setup();
		const h = factory(document);
		speak(h, map, words);
		h.dispose();
		h.setWord(map.rangeFor(0, 3));
		expect(root.querySelectorAll("mark")).toHaveLength(0);
		expect(root.innerHTML).toBe(html);
	});

	it("ranges built while marks are painted, and words across nodes / emoji, still map", () => {
		const { root, map } = setup();
		const h = factory(document);
		const i = map.text.indexOf("bold");
		h.setWord(map.rangeFor(i - 7, i + 4)); // "Second bold": two nodes → two marks, one range
		expect(marks("univocal-word")).toHaveLength(2);
		const e = map.text.indexOf("😀");
		h.setWord(map.rangeFor(e, e + 2));
		expect(marks("univocal-word")).toHaveLength(1);
		expect(marks("univocal-word")[0]!.textContent).toBe("😀");
		h.clear();
		expect(root.querySelectorAll("mark")).toHaveLength(0);
		h.dispose();
	});

	it("the text map sees through painted marks: same text, original nodes, no spurious append", async () => {
		const { root, map, words } = setup();
		const appended: string[] = [];
		let mismatches = 0;
		const watch = watchRendering(map, { onAppend: (t) => appended.push(t), onMismatch: () => mismatches++ }, { debounceMs: 1 });
		const h = factory(document);
		speak(h, map, words, 10);
		const text = map.text;
		const nodes = map.entries.map((e) => e.node);
		expect(map.remap()).toBe(true);
		expect(map.text).toBe(text);
		expect(map.entries.map((e) => e.node)).toEqual(nodes);
		// A selection inside a mark piece maps back to the original offset.
		const mark = marks("univocal-word")[0]!;
		const sel = window.getSelection()!;
		const r = document.createRange();
		r.setStart(mark.firstChild!, 1);
		r.setEnd(mark.firstChild!, 2);
		sel.removeAllRanges();
		sel.addRange(r);
		const lastWord = words[9]!;
		expect(map.offsetForSelection(sel)).toBe(lastWord[0] + 1);
		expect(map.extend()).toBeNull();
		await new Promise((res) => setTimeout(res, 20));
		watch.flush();
		expect(appended).toEqual([]);
		expect(mismatches).toBe(0);
		h.clear();
		expect(root.querySelectorAll("mark")).toHaveLength(0);
		watch.disconnect();
		h.dispose();
	});
});

describe("highlight style toggle", () => {
	it("toggles the underline class on <body>", () => {
		setHighlightStyle(document, "underline");
		expect(document.body.classList.contains(UNDERLINE_STYLE_CLASS)).toBe(true);
		setHighlightStyle(document, "background");
		expect(document.body.classList.contains(UNDERLINE_STYLE_CLASS)).toBe(false);
	});
});
