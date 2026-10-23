/**
 * Reading-view text map: the rendered note's text nodes, verbatim (no
 * whitespace collapsing, so offsets map straight back), with `\n\n` around
 * blocks and `\n` after table cells and `<br>` — the protocol treats newlines
 * as sentence boundaries, so headings and list items without punctuation do
 * not run into the next block. Separators map to no node.
 *
 * Port of PreviewMD `read-aloud.js` extraction, adapted to Obsidian:
 *
 * - Obsidian virtualises long notes: `.markdown-preview-sizer` only holds
 *   the sections near the viewport. The map is therefore built per root
 *   child ("section"). `extend()` appends sections rendered after the last
 *   known one; sections removed above/below are simply unmapped until they
 *   come back (matched by element identity, else by identical text).
 * - The `<mark>` highlight fallback temporarily replaces text nodes with
 *   pieces; the walk maps pieces back to the original nodes (see pieces.ts),
 *   so a walk during painting yields the same text and entries.
 */
import { clamp, firstVisibleIndex, lowerBound, separatorFor, slicesFor } from "./core";
import { isFallbackNode, liveNodeFor, originalPoint, originOf } from "./pieces";
import type { ReadingViewTextMap, ReadingViewTextMapOptions, TextEntry } from "./types";

/**
 * Not read: code blocks, front matter / properties, embeds, Obsidian's
 * chrome (fold indicators, edit buttons, inline title, backlinks footer),
 * media, maths, form controls and anything hidden.
 */
export const DEFAULT_SKIP_SELECTORS: readonly string[] = [
	"pre",
	".frontmatter",
	".frontmatter-container",
	".metadata-container",
	".internal-embed",
	".edit-block-button",
	".collapse-indicator",
	"button",
	"svg",
	"img",
	".math",
	"mjx-container",
	"math",
	"[hidden]",
	'[aria-hidden="true"]',
	"script",
	"style",
	"template",
	"noscript",
	"video",
	"audio",
	"canvas",
	"iframe",
	"object",
	"embed",
	"input",
	"select",
	"textarea",
	".inline-title",
	".mod-footer",
	".embedded-backlinks",
	".footnote-backref",
	".copy-code-button",
	".markdown-preview-pusher",
];

/** Newlines after an element (also after a skipped one, so text on either side stays apart). */
const BREAK_AFTER: Record<string, number> = {
	p: 2, h1: 2, h2: 2, h3: 2, h4: 2, h5: 2, h6: 2, li: 2, blockquote: 2, dt: 2, dd: 2,
	figcaption: 2, tr: 2, hr: 2, summary: 2, pre: 2, div: 2, section: 2, article: 2,
	aside: 2, header: 2, footer: 2, nav: 2, figure: 2, table: 2, thead: 2, tbody: 2,
	tfoot: 2, caption: 2, ul: 2, ol: 2, dl: 2, details: 2, address: 2, main: 2,
	td: 1, th: 1, br: 1,
};

/** Whitespace-only text with a newline directly inside these is markup formatting, not content. */
const BLOCK_CONTAINERS: Record<string, 1> = {
	article: 1, ul: 1, ol: 1, dl: 1, table: 1, thead: 1, tbody: 1, tfoot: 1, tr: 1,
	blockquote: 1, details: 1, section: 1, figure: 1, div: 1,
};
const FORMATTING_WHITESPACE = /^[ \t\r\n]*\n[ \t\r\n]*$/;

interface Chunk {
	key: Node;
	text: string;
	/** Starts local to the chunk. */
	entries: TextEntry[];
}

interface Section {
	key: Node;
	start: number;
	text: string;
}

function rectOfNode(node: Node): DOMRect | null {
	const doc = node.ownerDocument;
	if (!doc) return null;
	const r = doc.createRange();
	try {
		r.selectNodeContents(node);
	} catch {
		return null;
	}
	// jsdom (and very old engines) lack Range geometry: fall back to the parent element.
	if (typeof r.getBoundingClientRect === "function") return r.getBoundingClientRect();
	const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
	return el ? el.getBoundingClientRect() : null;
}

class ReadingViewTextMapImpl implements ReadingViewTextMap {
	readonly root: HTMLElement;
	private _text = "";
	private _entries: TextEntry[] = [];
	private _inSync = true;
	private readonly sections: Section[] = [];
	private readonly keyIndex = new Map<Node, number>();
	private nodeIndex = new Map<Text, number>();
	private readonly skip: string;
	private readonly isComplete: (() => boolean) | undefined;

	constructor(root: HTMLElement, options: ReadingViewTextMapOptions = {}) {
		this.root = root;
		this.skip = [...DEFAULT_SKIP_SELECTORS, ...(options.skipSelectors ?? [])].join(",");
		this.isComplete = options.isComplete;
		this.rebind(true);
	}

	get text(): string {
		return this._text;
	}

	get entries(): readonly TextEntry[] {
		return this._entries;
	}

	get complete(): boolean {
		return this.isComplete ? this.isComplete() : true;
	}

	get inSync(): boolean {
		return this._inSync;
	}

	// ── Mapping ────────────────────────────────────────────────

	rangeFor(start: number, end: number): Range[] {
		const len = this._text.length;
		const s = clamp(Math.floor(start), 0, len);
		const e = clamp(Math.floor(end), 0, len);
		const doc = this.root.ownerDocument;
		const out: Range[] = [];
		for (const sl of slicesFor(this._entries, s, e)) {
			const node = this._entries[sl.index]!.node;
			const r = doc.createRange();
			try {
				r.setStart(node, sl.start);
				r.setEnd(node, sl.end);
			} catch {
				continue; // the node's text changed under us
			}
			out.push(r);
		}
		return out;
	}

	offsetForSelection(selection: Selection | null): number | null {
		if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
		const r = selection.getRangeAt(0);
		if (!this.root.contains(r.startContainer)) return null;
		return this.pointOffset(r.startContainer, r.startOffset);
	}

	offsetAt(node: Node, offsetInNode: number): number | null {
		return this.pointOffset(node, offsetInNode);
	}

	/**
	 * Exact inside a mapped text node (or a `<mark>` piece of one); otherwise
	 * (an element boundary, a skipped code block) the start of the first
	 * mapped text after the point. `null` outside the root or past the end.
	 */
	private pointOffset(node: Node, offset: number): number | null {
		const p = originalPoint(node, offset);
		if (p.node.nodeType === 3) {
			const i = this.nodeIndex.get(p.node as Text);
			if (i !== undefined) {
				const e = this._entries[i]!;
				return e.start + clamp(p.offset, 0, e.length);
			}
		}
		if (!this.root.contains(node)) return null;
		const at = this.root.ownerDocument.createRange();
		try {
			at.setStart(node, offset);
		} catch {
			return null;
		}
		const entries = this._entries;
		const i = lowerBound(entries.length, (k) => {
			try {
				return at.comparePoint(liveNodeFor(entries[k]!.node), 0) >= 0;
			} catch {
				return false;
			}
		});
		return i < entries.length ? entries[i]!.start : null;
	}

	firstVisibleOffset(scroller: Element): number {
		const entries = this._entries;
		const starts: number[] = [];
		for (let i = 0; i < entries.length; i++) {
			const s = entries[i]!.start;
			if (s === 0 || this._text.charCodeAt(s - 1) === 10) starts.push(i);
		}
		if (!starts.length) return 0;
		const view = scroller.getBoundingClientRect();
		const height = view.height || scroller.clientHeight;
		if (!(height > 0)) return 0;
		const rects: ({ top: number; bottom: number } | undefined)[] = [];
		const rectOf = (k: number) => {
			let r = rects[k];
			if (!r) {
				const b = rectOfNode(liveNodeFor(entries[starts[k]!]!.node));
				r = b && (b.width || b.height) ? { top: b.top - view.top, bottom: b.bottom - view.top } : { top: -1, bottom: -1 };
				rects[k] = r;
			}
			return r;
		};
		const first = lowerBound(starts.length, (k) => rectOf(k).bottom > 0);
		const tops: number[] = [];
		const bottoms: number[] = [];
		for (let k = first; k < starts.length; k++) {
			const r = rectOf(k);
			tops.push(r.top);
			bottoms.push(r.bottom);
			if (r.top >= height) break;
		}
		const v = firstVisibleIndex(tops, bottoms, height);
		return v < 0 ? 0 : entries[starts[first + v]!]!.start;
	}

	// ── Re-walking ─────────────────────────────────────────────

	extend(): string | null {
		const added = this.rebind(true);
		return added ? added : null;
	}

	remap(): boolean {
		this.rebind(false);
		return this._inSync;
	}

	/**
	 * Walk every root child, match each non-empty chunk to a known section
	 * (same element, else same text, in order), re-bind entries, and — when
	 * `append` — add chunks rendered after the last known section. Returns
	 * the appended text ("" when none).
	 */
	private rebind(append: boolean): string {
		const chunks: Chunk[] = [];
		for (let child = this.root.firstChild; child; child = child.nextSibling) {
			const c = this.walkChunk(child);
			if (c.text) chunks.push(c);
		}
		const sections = this.sections;
		const present = new Set<Node>();
		for (const c of chunks) present.add(c.key);

		const entries: TextEntry[] = [];
		const trailing: Chunk[] = [];
		let cursor = 0;
		let pending = 0; // unmatched chunks since the last match
		let matchedAny = false;
		let ok = true;

		for (const c of chunks) {
			let k = -1;
			const known = this.keyIndex.get(c.key);
			if (known !== undefined) {
				if (known < cursor) {
					ok = false; // out of order
					continue;
				}
				if (sections[known]!.text !== c.text) {
					ok = false; // re-rendered with different text
					cursor = known + 1;
					pending = 0;
					matchedAny = true;
					continue;
				}
				k = known;
			} else {
				for (let j = cursor; j < sections.length; j++) {
					const s = sections[j]!;
					if (!present.has(s.key) && s.text === c.text) {
						k = j;
						break;
					}
				}
			}
			if (k >= 0) {
				// Unknown content in place of known sections, or inserted between
				// them, or a section missing between two present ones.
				if (pending > 0 && (k > cursor || cursor > 0)) ok = false;
				else if (pending === 0 && k > cursor && matchedAny) ok = false;
				pending = 0;
				const s = sections[k]!;
				if (s.key !== c.key) {
					this.keyIndex.delete(s.key);
					s.key = c.key;
					this.keyIndex.set(c.key, k);
				}
				for (const e of c.entries) entries.push({ node: e.node, start: s.start + e.start, length: e.length });
				cursor = k + 1;
				matchedAny = true;
			} else if (cursor === sections.length && (matchedAny || sections.length === 0)) {
				trailing.push(c); // rendered after the last known section
			} else {
				pending++;
			}
		}
		if (pending > 0 && matchedAny && cursor < sections.length) ok = false;

		let added = "";
		if (append) {
			for (const c of trailing) {
				const start = this._text.length + added.length;
				this.keyIndex.set(c.key, sections.length);
				sections.push({ key: c.key, start, text: c.text });
				for (const e of c.entries) entries.push({ node: e.node, start: start + e.start, length: e.length });
				added += c.text;
			}
			this._text += added;
		}

		this._entries = entries;
		const index = new Map<Text, number>();
		for (let i = 0; i < entries.length; i++) index.set(entries[i]!.node, i);
		this.nodeIndex = index;
		this._inSync = ok;
		return added;
	}

	private isSkipped(el: Element): boolean {
		try {
			if (el.matches(this.skip)) return true;
		} catch {
			// an invalid custom selector: ignore it rather than read nothing
		}
		const style = (el as HTMLElement).style;
		return !!style && style.display === "none";
	}

	private walkChunk(node: Node): Chunk {
		const out: Chunk = { key: node, text: "", entries: [] };
		if (node.nodeType === 3) this.visitText(out, node as Text, true);
		else if (node.nodeType === 1) this.visitElement(out, node as Element);
		return out;
	}

	private visitText(out: Chunk, t: Text, inBlockContainer: boolean): void {
		let node = t;
		const origin = originOf(t);
		if (origin) {
			// The first piece of a wrapped node stands for the whole original.
			if (origin.base !== 0) return;
			node = origin.node;
		}
		const data = node.data;
		if (!data) return;
		// Markup formatting: a newline-bearing whitespace run inside a block
		// container, or right after a separator (e.g. after a nested list).
		if (!origin && FORMATTING_WHITESPACE.test(data) && (inBlockContainer || !out.text || out.text.endsWith("\n"))) return;
		out.entries.push({ node, start: out.text.length, length: data.length });
		out.text += data;
	}

	private visitChildren(out: Chunk, parent: Element): void {
		const block = BLOCK_CONTAINERS[parent.localName] === 1;
		for (let child = parent.firstChild; child; child = child.nextSibling) {
			if (child.nodeType === 3) this.visitText(out, child as Text, block);
			else if (child.nodeType === 1) this.visitElement(out, child as Element);
		}
	}

	private visitElement(out: Chunk, el: Element): void {
		const name = el.localName;
		const n = BREAK_AFTER[name];
		// A block starting mid-text (`<li>Parent<ul>…`) must not run into it.
		if (n === 2) out.text += separatorFor(out.text, 2);
		if (!this.isSkipped(el)) {
			if (name === "details" && !el.hasAttribute("open")) this.visitClosedDetails(out, el);
			else this.visitChildren(out, el);
		}
		if (n) out.text += separatorFor(out.text, n);
	}

	/** A closed `<details>` shows only its `<summary>`. */
	private visitClosedDetails(out: Chunk, details: Element): void {
		for (let child = details.firstChild; child; child = child.nextSibling) {
			if (child.nodeType === 1 && (child as Element).localName === "summary" && !this.isSkipped(child as Element)) {
				this.visitChildren(out, child as Element);
				out.text += separatorFor(out.text, 2);
			}
		}
	}
}

/** Build a text map over `root` (normally `.markdown-preview-sizer`). */
export function createReadingViewTextMap(root: HTMLElement, options?: ReadingViewTextMapOptions): ReadingViewTextMap {
	return new ReadingViewTextMapImpl(root, options);
}

export interface RenderWatchHandlers {
	/** Newly rendered trailing text, exactly as appended to `map.text` — send it with `append`. */
	onAppend?(text: string): void;
	/** The rendered content no longer matches the session text (see `ReadingViewTextMap.remap`). */
	onMismatch?(): void;
}

export interface RenderWatch {
	/** Run a pending re-walk now. */
	flush(): void;
	disconnect(): void;
}

function isFallbackRecord(r: MutationRecord): boolean {
	if (r.type === "characterData") return isFallbackNode(r.target);
	if (r.type !== "childList") return false;
	for (let i = 0; i < r.addedNodes.length; i++) if (!isFallbackNode(r.addedNodes[i]!)) return false;
	for (let i = 0; i < r.removedNodes.length; i++) if (!isFallbackNode(r.removedNodes[i]!)) return false;
	return true;
}

/**
 * Observe `map.root` and re-walk (debounced) when sections are rendered or
 * replaced: new trailing text goes to `onAppend`, a content change to
 * `onMismatch`. Mutations made by the `<mark>` fallback are ignored.
 */
export function watchRendering(map: ReadingViewTextMap, handlers: RenderWatchHandlers, options: { debounceMs?: number } = {}): RenderWatch {
	const debounceMs = options.debounceMs ?? 50;
	const win = map.root.ownerDocument.defaultView;
	const MO = (win as (Window & { MutationObserver?: typeof MutationObserver }) | null)?.MutationObserver ?? globalThis.MutationObserver;
	const setT = win ? win.setTimeout.bind(win) : setTimeout;
	const clearT = win ? win.clearTimeout.bind(win) : clearTimeout;
	let timer: ReturnType<typeof setTimeout> | number | null = null;
	let live = true;
	let dirty = false;

	const run = () => {
		if (timer !== null) clearT(timer as number);
		timer = null;
		if (!live || !dirty) return;
		dirty = false;
		const added = map.extend();
		if (added) handlers.onAppend?.(added);
		if (!map.inSync) handlers.onMismatch?.();
	};

	const observer = new MO((records) => {
		if (!live || records.every(isFallbackRecord)) return;
		dirty = true;
		if (timer !== null) clearT(timer as number);
		timer = setT(run, debounceMs);
	});
	observer.observe(map.root, { childList: true, subtree: true, characterData: true });

	return {
		flush() {
			// Deliver records the observer has queued but not yet reported.
			const queued = observer.takeRecords();
			if (queued.length && !queued.every(isFallbackRecord)) dirty = true;
			run();
		},
		disconnect() {
			live = false;
			observer.disconnect();
			if (timer !== null) clearT(timer as number);
			timer = null;
		},
	};
}
