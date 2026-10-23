/**
 * Editor (Live Preview / source) text map. The session text is the CM6 doc
 * string (`editor.getValue()`, `\n`-normalised), so session offsets ARE CM
 * positions: `rangeFor` is the identity, clamped to the doc.
 */
import type { EditorView } from "@codemirror/view";
import { clamp } from "./core";
import type { EditorRange, EditorTextMap, EditorTextMapOptions } from "./types";

/** Shape of Obsidian's `CachedMetadata.frontmatterPosition` (only what we read). */
export interface FrontmatterPositionLike {
	end: { offset: number };
}

const FRONTMATTER = /^---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/**
 * Where reading starts: just after the front matter (and the blank lines that
 * follow it), else 0. Uses Obsidian's cached `frontmatterPosition` when given,
 * else recognises a leading `---` … `---` block itself.
 */
export function bodyStartFor(text: string, frontmatterPosition?: FrontmatterPositionLike | null): number {
	let end: number;
	if (frontmatterPosition && Number.isFinite(frontmatterPosition.end.offset)) {
		end = clamp(Math.floor(frontmatterPosition.end.offset), 0, text.length);
	} else {
		const m = FRONTMATTER.exec(text);
		if (!m) return 0;
		end = m[0].length;
	}
	while (end < text.length) {
		const c = text.charCodeAt(end);
		if (c === 10 || c === 13 || c === 32 || c === 9) end++;
		else break;
	}
	return end;
}

class EditorTextMapImpl implements EditorTextMap {
	readonly text: string;
	readonly bodyStart: number;

	constructor(text: string, bodyStart: number) {
		this.text = text;
		this.bodyStart = clamp(Math.floor(bodyStart), 0, text.length);
	}

	rangeFor(start: number, end: number): EditorRange {
		const len = this.text.length;
		const from = clamp(Math.floor(start), 0, len);
		const to = clamp(Math.floor(end), from, len);
		return { from, to };
	}

	offsetForSelection(view: EditorView): number | null {
		const sel = view.state.selection.main;
		if (sel.empty) return null;
		return clamp(sel.from, 0, this.text.length);
	}

	firstVisibleOffset(view: EditorView): number {
		let pos = this.bodyStart;
		try {
			const scroller = view.scrollDOM.getBoundingClientRect();
			// Height of the scroller's top edge inside the document.
			const h = Math.max(0, scroller.top - view.documentTop);
			const block = view.lineBlockAtHeight(h);
			// The first line whose top is on screen; a partly hidden line → the next one,
			// unless that one starts below the viewport (a line taller than the viewport).
			let from = block.from;
			if (block.top < h - 1 && block.to < view.state.doc.length) {
				const next = view.lineBlockAt(block.to + 1);
				if (next.top < h + scroller.height) from = next.from;
			}
			pos = Math.max(from, this.bodyStart);
		} catch {
			// headless / not laid out: start at the body
		}
		return clamp(pos, 0, this.text.length);
	}
}

/**
 * Text map for an editor view. `bodyStart` defaults to 0; pass
 * `bodyStartFor(text, cache.frontmatterPosition)` to skip front matter.
 */
export function createEditorTextMap(view: EditorView, options: EditorTextMapOptions = {}): EditorTextMap {
	return new EditorTextMapImpl(view.state.doc.toString(), options.bodyStart ?? 0);
}

/** Same, from a plain string (tests, or when the caller already holds `editor.getValue()`). */
export function editorTextMapFromText(text: string, options: EditorTextMapOptions = {}): EditorTextMap {
	return new EditorTextMapImpl(text, options.bodyStart ?? 0);
}
