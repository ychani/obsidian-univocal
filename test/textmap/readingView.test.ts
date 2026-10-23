import { afterEach, describe, expect, it, vi } from "vitest";
import { createReadingViewTextMap, watchRendering } from "../../src/textmap/readingView";
import type { ReadingViewTextMap, ReadingViewTextMapFactory } from "../../src/textmap/types";

// The factory matches the stub's type.
const factory: ReadingViewTextMapFactory = createReadingViewTextMap;

function sizer(html: string): HTMLElement {
	document.body.innerHTML = "";
	const view = document.createElement("div");
	view.className = "markdown-preview-view";
	const root = document.createElement("div");
	root.className = "markdown-preview-sizer markdown-preview-section";
	root.innerHTML = html;
	view.appendChild(root);
	document.body.appendChild(view);
	return root;
}

/** The text a range list covers, with separators (which map to no node) left out. */
function rangesText(ranges: Range[]): string {
	return ranges.map((r) => r.toString()).join("");
}

/** `map.text.slice(start, end)` without the characters no entry covers. */
function mappedSlice(map: ReadingViewTextMap, start: number, end: number): string {
	let out = "";
	for (const e of map.entries) {
		const a = Math.max(start, e.start);
		const b = Math.min(end, e.start + e.length);
		if (b > a) out += map.text.slice(a, b);
	}
	return out;
}

/** Every word (and every line) maps back to exactly its text; arbitrary spans to their mapped text. */
function expectRoundTrip(map: ReadingViewTextMap): void {
	for (const m of map.text.matchAll(/[^\s]+/gu)) {
		const start = m.index!;
		const end = start + m[0].length;
		expect(rangesText(map.rangeFor(start, end)), `word ${JSON.stringify(m[0])}`).toBe(map.text.slice(start, end));
	}
	for (const m of map.text.matchAll(/[^\n]+/g)) {
		const start = m.index!;
		expect(rangesText(map.rangeFor(start, start + m[0].length))).toBe(m[0]);
	}
	const n = map.text.length;
	for (let s = 0; s < n; s += 3) {
		for (let e = s; e <= n; e += 7) {
			expect(rangesText(map.rangeFor(s, e))).toBe(mappedSlice(map, s, e));
		}
	}
	// Entries are sorted, non-overlapping, and hold their node's text.
	let last = 0;
	for (const e of map.entries) {
		expect(e.start).toBeGreaterThanOrEqual(last);
		expect(map.text.slice(e.start, e.start + e.length)).toBe(e.node.data);
		last = e.start + e.length;
	}
}

const p = (html: string) => `<div class="el-p"><p dir="auto">${html}</p></div>`;

describe("reading-view text map: extraction", () => {
	it("headings and paragraphs, skipping the fold indicator", () => {
		const root = sizer(
			`<div class="el-h2"><h2 data-heading="Title" dir="auto"><div class="heading-collapse-indicator collapse-indicator collapse-icon"><svg></svg></div>Title</h2></div>` +
				p("Hello <em>brave</em> world.") +
				p("Second paragraph"),
		);
		const map = factory(root);
		expect(map.text).toBe("Title\n\nHello brave world.\n\nSecond paragraph\n\n");
		expect(map.complete).toBe(true);
		expect(map.inSync).toBe(true);
		expectRoundTrip(map);
		const i = map.text.indexOf("brave");
		const ranges = map.rangeFor(i, i + 5);
		expect(ranges).toHaveLength(1);
		expect(ranges[0]!.startContainer.parentElement!.localName).toBe("em");
	});

	it("emoji (surrogate pairs, ZWJ sequences) keep UTF-16 offsets", () => {
		const root = sizer(p("I 🫶 emoji 👩‍👩‍👧 and <strong>𝐁old</strong> ✔︎."));
		const map = createReadingViewTextMap(root);
		expect(map.text).toBe("I 🫶 emoji 👩‍👩‍👧 and 𝐁old ✔︎.\n\n");
		expectRoundTrip(map);
		const s = map.text.indexOf("👩");
		const family = "👩‍👩‍👧";
		expect(family.length).toBe(8);
		expect(rangesText(map.rangeFor(s, s + family.length))).toBe(family);
		const b = map.text.indexOf("𝐁");
		expect(rangesText(map.rangeFor(b, b + 5))).toBe("𝐁old");
	});

	it("CJK text and full-width punctuation", () => {
		const root = sizer(p("日本語のテキストです。中文句子！") + p("한국어 문장입니다."));
		const map = createReadingViewTextMap(root);
		expect(map.text).toBe("日本語のテキストです。中文句子！\n\n한국어 문장입니다.\n\n");
		expectRoundTrip(map);
		const i = map.text.indexOf("中文");
		expect(rangesText(map.rangeFor(i, i + 2))).toBe("中文");
	});

	it("combining marks stay with their base characters", () => {
		const text = "Café naïve résumé";
		const root = sizer(p(text));
		const map = createReadingViewTextMap(root);
		expect(map.text).toBe(text + "\n\n");
		expectRoundTrip(map);
		expect(rangesText(map.rangeFor(0, 5))).toBe("Café");
	});

	it("tables: \\n after cells, \\n\\n after rows", () => {
		const root = sizer(
			`<div class="el-table"><table>\n<thead>\n<tr>\n<th>Name</th>\n<th>Role</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td>Ada</td>\n<td>Engineer</td>\n</tr>\n<tr>\n<td>Grace</td>\n<td><em>Admiral</em></td>\n</tr>\n</tbody>\n</table></div>`,
		);
		const map = createReadingViewTextMap(root);
		expect(map.text).toBe("Name\nRole\n\nAda\nEngineer\n\nGrace\nAdmiral\n\n");
		expectRoundTrip(map);
	});

	it("lists: formatting whitespace dropped, nested lists, task checkboxes", () => {
		const root = sizer(
			`<div class="el-ul"><ul>\n<li data-line="0" dir="auto"><div class="list-collapse-indicator collapse-indicator collapse-icon"><svg></svg></div>First item\n<ul>\n<li data-line="1">Nested <code>code</code></li>\n</ul>\n</li>\n<li data-line="2" class="task-list-item"><input type="checkbox" class="task-list-item-checkbox">Buy milk</li>\n</ul></div>` +
				`<div class="el-ol"><ol>\n<li>One</li>\n<li>Two</li>\n</ol></div>`,
		);
		const map = createReadingViewTextMap(root);
		expect(map.text).toBe("First item\n\nNested code\n\nBuy milk\n\nOne\n\nTwo\n\n");
		expectRoundTrip(map);
		// No markup whitespace at all: the nested block still does not run into its parent's text.
		const tight = createReadingViewTextMap(sizer(`<ul><li>Parent<ul><li>Child</li></ul></li><li>Next</li></ul>`));
		expect(tight.text).toBe("Parent\n\nChild\n\nNext\n\n");
	});

	it("callouts: title and body read, icons/fold skipped, collapsed content skipped", () => {
		const root = sizer(
			`<div class="el-div"><div data-callout-metadata="" data-callout-fold="" data-callout="note" class="callout"><div class="callout-title" dir="auto"><div class="callout-icon"><svg></svg></div><div class="callout-title-inner">Note</div></div><div class="callout-content">\n<p dir="auto">Callout body.</p>\n</div></div></div>` +
				`<div class="el-div"><div data-callout="tip" data-callout-fold="-" class="callout is-collapsible is-collapsed"><div class="callout-title"><div class="callout-icon"><svg></svg></div><div class="callout-title-inner">Folded</div><div class="callout-fold is-collapsed"><svg></svg></div></div><div class="callout-content" style="display: none;"><p>Hidden body.</p></div></div></div>`,
		);
		const map = createReadingViewTextMap(root);
		expect(map.text).toBe("Note\n\nCallout body.\n\nFolded\n\n");
		expectRoundTrip(map);
	});

	it("wikilinks: display text (incl. heading/block anchors) is read, hrefs are not; embeds skipped", () => {
		const root = sizer(
			p(
				`See <a data-href="Other#Section" href="Other#Section" class="internal-link" target="_blank" rel="noopener nofollow">Other &gt; Section</a>, ` +
					`<a data-href="Note#^abc123" href="Note#^abc123" class="internal-link">this block</a> and ` +
					`<a href="https://example.com" class="external-link">the web</a>. ` +
					`<span class="internal-embed image-embed is-loaded" src="pic.png" alt="pic.png"><img src="app://pic.png"></span>Done.`,
			) +
				`<div class="el-div"><div class="internal-embed markdown-embed inline-embed is-loaded" src="Other"><div class="markdown-embed-content"><p>Embedded note text</p></div></div></div>`,
		);
		const map = createReadingViewTextMap(root);
		expect(map.text).toBe("See Other > Section, this block and the web. Done.\n\n");
		expectRoundTrip(map);
		const i = map.text.indexOf("Section");
		expect(map.rangeFor(i, i + 7)[0]!.startContainer.parentElement!.classList.contains("internal-link")).toBe(true);
	});

	it("skips code, front matter, properties, maths, buttons, hidden, inline title and footer", () => {
		const root = sizer(
			`<div class="mod-header"><div class="inline-title">My Note</div><div class="metadata-container"><div class="metadata-property">tags: a</div></div></div>` +
				`<div class="el-pre mod-frontmatter mod-ui"><pre class="frontmatter language-yaml"><code>title: x</code></pre></div>` +
				p("Before code.") +
				`<div class="el-pre"><pre><code>let x = 1;</code><button class="copy-code-button">Copy</button></pre></div>` +
				p(`Maths <span class="math math-inline is-loaded"><mjx-container>x²</mjx-container></span>here.`) +
				p(`Shown <span hidden>hidden</span><span aria-hidden="true">aria</span>text.`) +
				`<div class="edit-block-button" aria-label="Edit this block"><svg></svg>Edit</div>` +
				p("After.") +
				`<div class="mod-footer"><div class="embedded-backlinks">Linked mentions</div></div>`,
		);
		const map = createReadingViewTextMap(root);
		expect(map.text).toBe("Before code.\n\nMaths here.\n\nShown text.\n\nAfter.\n\n");
		expectRoundTrip(map);
	});

	it("<br> is a line break; closed <details> shows only its summary", () => {
		const root = sizer(p("Line one<br>Line two") + `<details><summary>Summary</summary><p>Inside</p></details>`);
		const map = createReadingViewTextMap(root);
		expect(map.text).toBe("Line one\nLine two\n\nSummary\n\n");
		expectRoundTrip(map);
	});

	it("honours extra skip selectors and the isComplete option", () => {
		const root = sizer(p(`Keep <span class="tag">#drop</span>this.`));
		const map = createReadingViewTextMap(root, { skipSelectors: [".tag"], isComplete: () => false });
		expect(map.text).toBe("Keep this.\n\n");
		expect(map.complete).toBe(false);
	});

	it("clamps out-of-range input and returns [] for separators", () => {
		const root = sizer(p("Alpha") + p("Beta"));
		const map = createReadingViewTextMap(root);
		expect(rangesText(map.rangeFor(-10, 3))).toBe("Alp");
		expect(rangesText(map.rangeFor(7, 1000))).toBe("Beta");
		expect(map.rangeFor(5, 7)).toEqual([]);
		expect(map.rangeFor(4, 2)).toEqual([]);
	});
});

describe("reading-view text map: offsets", () => {
	it("offsetAt maps text points exactly and element points to the next text", () => {
		const root = sizer(p("Hello <b>bold</b> world") + `<div class="el-pre"><pre>code</pre></div>` + p("After"));
		const map = createReadingViewTextMap(root);
		const bold = root.querySelector("b")!.firstChild!;
		expect(map.offsetAt(bold, 2)).toBe(8);
		const pre = root.querySelector("pre")!;
		expect(map.offsetAt(pre.firstChild!, 1)).toBe(map.text.indexOf("After"));
		expect(map.offsetAt(root, 0)).toBe(0);
		expect(map.offsetAt(document.body, 0)).toBeNull();
		expect(map.offsetAt(root, root.childNodes.length)).toBeNull();
	});

	it("offsetForSelection: start of a non-empty selection inside the root, else null", () => {
		const root = sizer(p("Pick a word here."));
		const map = createReadingViewTextMap(root);
		const text = root.querySelector("p")!.firstChild!;
		const sel = window.getSelection()!;
		const r = document.createRange();
		r.setStart(text, 7);
		r.setEnd(text, 11);
		sel.removeAllRanges();
		sel.addRange(r);
		expect(map.offsetForSelection(sel)).toBe(7);
		sel.collapse(text, 3);
		expect(map.offsetForSelection(sel)).toBeNull();
		expect(map.offsetForSelection(null)).toBeNull();
		const outside = document.createElement("p");
		outside.textContent = "outside";
		document.body.appendChild(outside);
		const r2 = document.createRange();
		r2.selectNodeContents(outside);
		sel.removeAllRanges();
		sel.addRange(r2);
		expect(map.offsetForSelection(sel)).toBeNull();
	});

	describe("firstVisibleOffset", () => {
		afterEach(() => vi.restoreAllMocks());

		function layout(tops: Record<string, number>) {
			vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
				if (this.classList.contains("markdown-preview-view")) return new DOMRect(0, 0, 500, 100);
				const key = this.closest("[data-top]")?.getAttribute("data-top");
				if (key === undefined || key === null) return new DOMRect(0, 0, 0, 0);
				return new DOMRect(0, tops[key] ?? 0, 400, 20);
			});
		}

		it("returns the first block whose top is in the viewport", () => {
			const root = sizer(
				`<div data-top="a"><p>Above</p></div><div data-top="b"><p>Visible one</p></div><div data-top="c"><p>Visible two</p></div>`,
			);
			const map = createReadingViewTextMap(root);
			layout({ a: -50, b: 10, c: 50 });
			const scroller = root.parentElement!;
			expect(map.firstVisibleOffset(scroller)).toBe(map.text.indexOf("Visible one"));
		});

		it("falls back to a block still partly on screen, and to 0 when nothing is", () => {
			const root = sizer(`<div data-top="a"><p>Tall</p></div><div data-top="b"><p>Below</p></div>`);
			const map = createReadingViewTextMap(root);
			const scroller = root.parentElement!;
			layout({ a: -10, b: 200 });
			expect(map.firstVisibleOffset(scroller)).toBe(0);
			layout({ a: -100, b: -50 });
			expect(map.firstVisibleOffset(scroller)).toBe(0);
		});
	});
});

describe("reading-view text map: virtualised rendering", () => {
	const section = (text: string) => {
		const el = document.createElement("div");
		el.className = "el-p";
		el.innerHTML = `<p>${text}</p>`;
		return el;
	};

	it("extend() appends sections rendered after the last one, once", () => {
		const root = sizer("");
		root.append(section("One."), section("Two."));
		const map = createReadingViewTextMap(root);
		expect(map.text).toBe("One.\n\nTwo.\n\n");
		expect(map.extend()).toBeNull();
		root.append(section("Three 😀."));
		expect(map.extend()).toBe("Three 😀.\n\n");
		expect(map.text).toBe("One.\n\nTwo.\n\nThree 😀.\n\n");
		expect(map.extend()).toBeNull();
		expectRoundTrip(map);
	});

	it("sections virtualised away are unmapped, then rebound when they return", () => {
		const root = sizer("");
		const one = section("One.");
		const two = section("Two.");
		root.append(one, two);
		const map = createReadingViewTextMap(root);
		one.remove();
		expect(map.extend()).toBeNull();
		expect(map.inSync).toBe(true);
		expect(map.rangeFor(0, 4)).toEqual([]);
		expect(rangesText(map.rangeFor(6, 10))).toBe("Two.");
		root.prepend(one);
		expect(map.remap()).toBe(true);
		expect(rangesText(map.rangeFor(0, 4))).toBe("One.");
	});

	it("sections rendered above the start are not appended and not a mismatch", () => {
		const root = sizer("");
		root.append(section("Middle."));
		const map = createReadingViewTextMap(root);
		root.prepend(section("Top."));
		expect(map.extend()).toBeNull();
		expect(map.inSync).toBe(true);
		expect(map.text).toBe("Middle.\n\n");
	});

	it("remap() rebinds to re-rendered nodes with the same text", () => {
		const root = sizer("");
		root.append(section("Alpha beta."), section("Gamma."));
		const map = createReadingViewTextMap(root);
		const oldNode = map.entries[0]!.node;
		root.replaceChildren(section("Alpha beta."), section("Gamma."));
		expect(map.remap()).toBe(true);
		expect(map.entries[0]!.node).not.toBe(oldNode);
		expect(map.entries[0]!.node.isConnected).toBe(true);
		expect(rangesText(map.rangeFor(6, 10))).toBe("beta");
	});

	it("remap() reports a content change", () => {
		const root = sizer("");
		root.append(section("One."), section("Two."), section("Three."));
		const map = createReadingViewTextMap(root);
		root.children[1]!.replaceWith(section("Two, edited."));
		expect(map.remap()).toBe(false);
		expect(map.text).toBe("One.\n\nTwo.\n\nThree.\n\n");
		const map2 = createReadingViewTextMap(root);
		root.querySelector("p")!.firstChild!.textContent = "Uno.";
		expect(map2.remap()).toBe(false);
	});

	it("watchRendering delivers appended text and ignores nothing-changed mutations", async () => {
		const root = sizer("");
		root.append(section("First."));
		const map = createReadingViewTextMap(root);
		const appended: string[] = [];
		let mismatches = 0;
		const watch = watchRendering(map, { onAppend: (t) => appended.push(t), onMismatch: () => mismatches++ }, { debounceMs: 5 });
		root.append(section("Second."));
		await new Promise((r) => setTimeout(r, 30));
		expect(appended).toEqual(["Second.\n\n"]);
		root.append(section("Third."));
		watch.flush();
		expect(appended).toEqual(["Second.\n\n", "Third.\n\n"]);
		root.children[0]!.replaceWith(section("First, changed."));
		watch.flush();
		expect(mismatches).toBe(1);
		watch.disconnect();
		root.append(section("Fourth."));
		await new Promise((r) => setTimeout(r, 30));
		expect(appended).toHaveLength(2);
	});
});
