/**
 * Reading-view highlighter.
 *
 * Primary: CSS Custom Highlight API on the view's ownerDocument (popout
 * windows have their own `CSS.highlights`). One `Highlight` per name, owned by
 * this instance; every set REPLACES its contents (`clear()` then `add()`), so
 * there is never more than one live word range and one live sentence range.
 *
 * Fallback (no `CSS.highlights`): wrap the ranges in `<mark>` pieces and put
 * the original text nodes back — exactly — on every set and clear.
 */
import { registerFallbackElement, registerPiece, registerWrap, originalPoint, unregisterWrap } from "../textmap/pieces";
import {
	SENTENCE_HIGHLIGHT,
	WORD_HIGHLIGHT,
	type PaintedCount,
	type ReadingViewHighlighter,
	type ReadingViewHighlighterOptions,
} from "./types";

/** The parts of the Highlight / HighlightRegistry interfaces we use. */
interface HighlightLike {
	priority: number;
	readonly size: number;
	add(range: AbstractRange): unknown;
	clear(): void;
}
interface HighlightRegistryLike {
	get(name: string): unknown;
	set(name: string, highlight: HighlightLike): unknown;
	delete(name: string): boolean;
}
type HighlightCtor = new (...ranges: AbstractRange[]) => HighlightLike;

interface HighlightWindow {
	Highlight?: HighlightCtor;
	CSS?: { highlights?: HighlightRegistryLike };
}

function highlightApi(doc: Document): { Ctor: HighlightCtor; registry: HighlightRegistryLike } | null {
	const win = doc.defaultView as (Window & HighlightWindow) | null;
	const Ctor = win?.Highlight;
	const registry = win?.CSS?.highlights;
	if (typeof Ctor !== "function" || !registry || typeof registry.set !== "function") return null;
	return { Ctor, registry };
}

class CssHighlighter implements ReadingViewHighlighter {
	readonly mode = "css-highlight" as const;
	private readonly registry: HighlightRegistryLike;
	private readonly word: HighlightLike;
	private readonly sentence: HighlightLike;
	private disposed = false;

	constructor(api: { Ctor: HighlightCtor; registry: HighlightRegistryLike }) {
		this.registry = api.registry;
		this.word = new api.Ctor();
		this.word.priority = 1;
		this.sentence = new api.Ctor();
		this.sentence.priority = 0;
		// Overwrites anything a previous (reloaded) plugin instance left behind.
		this.ensureRegistered();
	}

	private ensureRegistered(): void {
		try {
			if (this.registry.get(SENTENCE_HIGHLIGHT) !== this.sentence) this.registry.set(SENTENCE_HIGHLIGHT, this.sentence);
			if (this.registry.get(WORD_HIGHLIGHT) !== this.word) this.registry.set(WORD_HIGHLIGHT, this.word);
		} catch {
			// a foreign registry refused us; painting simply does not show
		}
	}

	private replace(h: HighlightLike, ranges: Range[] | null): void {
		if (this.disposed) return;
		h.clear();
		if (ranges) for (const r of ranges) h.add(r);
		this.ensureRegistered();
	}

	setWord(range: Range[] | null): void {
		this.replace(this.word, range);
	}

	paintedRangeCount(): PaintedCount {
		if (this.disposed) return { word: 0, sentence: 0 };
		return { word: this.word.size, sentence: this.sentence.size };
	}

	setSentence(range: Range[] | null): void {
		this.replace(this.sentence, range);
	}

	clear(): void {
		if (this.disposed) return;
		this.word.clear();
		this.sentence.clear();
	}

	/** Clears and deletes this instance's `CSS.highlights` entries. */
	dispose(): void {
		if (this.disposed) return;
		this.clear();
		this.disposed = true;
		for (const [name, h] of [
			[WORD_HIGHLIGHT, this.word],
			[SENTENCE_HIGHLIGHT, this.sentence],
		] as const) {
			try {
				// Only our own entry: a newer instance on this document keeps its own.
				if (this.registry.get(name) === h) this.registry.delete(name);
			} catch {
				// ignore
			}
		}
	}
}

/** A highlighted part of one original text node. */
interface Span {
	node: Text;
	start: number;
	end: number;
}

interface Wrap {
	node: Text;
	pieces: Node[];
}

const SENTENCE_FLAG = 1;
const WORD_FLAG = 2;

/**
 * Text-node spans covered by `range`, in terms of ORIGINAL nodes (pieces of a
 * currently wrapped node map back). Computed before any DOM mutation, because
 * wrapping removes nodes and would collapse live ranges.
 */
function spansOf(range: Range): Span[] {
	const out: Span[] = [];
	const push = (node: Node, start: number, end: number) => {
		const a = originalPoint(node, start);
		const b = originalPoint(node, end);
		if (a.node.nodeType === 3 && b.offset > a.offset) out.push({ node: a.node as Text, start: a.offset, end: b.offset });
	};
	const sc = range.startContainer;
	if (sc === range.endContainer) {
		if (sc.nodeType === 3) push(sc, range.startOffset, range.endOffset);
		else collectInside(range, push);
		return out;
	}
	collectInside(range, push);
	return out;
}

function collectInside(range: Range, push: (node: Node, start: number, end: number) => void): void {
	const rootNode = range.commonAncestorContainer;
	const doc = rootNode.ownerDocument ?? (rootNode as Document);
	if (rootNode.nodeType === 3) {
		push(rootNode, range.startOffset, range.endOffset);
		return;
	}
	const walker = doc.createTreeWalker(rootNode, 4 /* NodeFilter.SHOW_TEXT */);
	for (let n = walker.nextNode(); n; n = walker.nextNode()) {
		const t = n as Text;
		if (!range.intersectsNode(t)) continue;
		const start = t === range.startContainer ? range.startOffset : 0;
		const end = t === range.endContainer ? range.endOffset : t.data.length;
		push(t, start, end);
	}
}

class MarkHighlighter implements ReadingViewHighlighter {
	readonly mode = "mark" as const;
	private readonly doc: Document;
	private word: Span[] = [];
	private sentence: Span[] = [];
	private wraps: Wrap[] = [];
	private disposed = false;

	constructor(doc: Document) {
		this.doc = doc;
	}

	setWord(range: Range[] | null): void {
		if (this.disposed) return;
		// Capture before unwrapping: the input ranges may sit inside pieces.
		this.word = range ? range.flatMap(spansOf) : [];
		this.repaint();
	}

	setSentence(range: Range[] | null): void {
		if (this.disposed) return;
		this.sentence = range ? range.flatMap(spansOf) : [];
		this.repaint();
	}

	paintedRangeCount(): PaintedCount {
		let word = 0;
		let sentence = 0;
		for (const w of this.wraps) {
			for (const piece of w.pieces) {
				if (piece.nodeType !== 1 || !piece.parentNode) continue;
				const cl = (piece as Element).classList;
				if (cl.contains(WORD_HIGHLIGHT)) word++;
				if (cl.contains(SENTENCE_HIGHLIGHT)) sentence++;
			}
		}
		return { word, sentence };
	}

	clear(): void {
		if (this.disposed) return;
		this.word = [];
		this.sentence = [];
		this.unwrap();
	}

	dispose(): void {
		if (this.disposed) return;
		this.clear();
		this.disposed = true;
	}

	private repaint(): void {
		this.unwrap();
		this.wrap();
	}

	/** Put every original node back where its pieces are, and drop the pieces. */
	private unwrap(): void {
		for (let i = this.wraps.length - 1; i >= 0; i--) {
			const w = this.wraps[i]!;
			const first = w.pieces[0];
			const parent = first?.parentNode;
			unregisterWrap(w.node);
			if (!first || !parent) continue; // re-rendered away; nothing to restore
			parent.insertBefore(w.node, first);
			for (const p of w.pieces) if (p.parentNode === parent) parent.removeChild(p);
		}
		this.wraps = [];
	}

	private wrap(): void {
		const byNode = new Map<Text, { start: number; end: number; flag: number }[]>();
		const add = (spans: Span[], flag: number) => {
			for (const s of spans) {
				let list = byNode.get(s.node);
				if (!list) byNode.set(s.node, (list = []));
				list.push({ start: s.start, end: s.end, flag });
			}
		};
		add(this.sentence, SENTENCE_FLAG);
		add(this.word, WORD_FLAG);
		for (const [node, list] of byNode) {
			const parent = node.parentNode;
			if (!parent) continue;
			const data = node.data;
			const cuts = [0, data.length];
			for (const s of list) cuts.push(Math.min(Math.max(s.start, 0), data.length), Math.min(Math.max(s.end, 0), data.length));
			cuts.sort((a, b) => a - b);
			// Segments between cuts, adjacent ones with equal flags merged (one mark per run).
			const segments: { a: number; b: number; flags: number }[] = [];
			for (let k = 0; k + 1 < cuts.length; k++) {
				const a = cuts[k]!;
				const b = cuts[k + 1]!;
				if (b <= a) continue;
				let flags = 0;
				for (const s of list) if (s.start <= a && s.end >= b) flags |= s.flag;
				const prev = segments[segments.length - 1];
				if (prev && prev.flags === flags && prev.b === a) prev.b = b;
				else segments.push({ a, b, flags });
			}
			const pieces: Node[] = [];
			for (const { a, b, flags } of segments) {
				const text = this.doc.createTextNode(data.slice(a, b));
				registerPiece(text, node, a);
				if (!flags) {
					pieces.push(text);
					continue;
				}
				const mark = this.doc.createElement("mark");
				const classes: string[] = [];
				if (flags & SENTENCE_FLAG) classes.push(SENTENCE_HIGHLIGHT);
				if (flags & WORD_FLAG) classes.push(WORD_HIGHLIGHT);
				mark.className = classes.join(" ");
				mark.appendChild(text);
				registerFallbackElement(mark);
				pieces.push(mark);
			}
			if (!pieces.length) continue;
			registerWrap(node, pieces[0]!);
			for (const p of pieces) parent.insertBefore(p, node);
			parent.removeChild(node);
			this.wraps.push({ node, pieces });
		}
	}
}

/**
 * One highlighter per document (the names are per-registry). Uses the CSS
 * Custom Highlight API when `doc.defaultView` has it, else the `<mark>` fallback.
 */
export function createReadingViewHighlighter(doc: Document, options: ReadingViewHighlighterOptions = {}): ReadingViewHighlighter {
	const api = options.forceFallback ? null : highlightApi(doc);
	return api ? new CssHighlighter(api) : new MarkHighlighter(doc);
}
