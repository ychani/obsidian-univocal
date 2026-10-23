/**
 * Text maps: the session text sent to Univocal, plus the mapping between its
 * UTF-16 offsets and where that text lives on screen (plan §2).
 *
 * All offsets are half-open `[start, end)` UTF-16 code-unit indices into
 * `text` — the same unit the protocol uses. Never convert via code points.
 */
import type { EditorView } from "@codemirror/view";

/** A position range in the CodeMirror 6 document. */
export interface EditorRange {
	from: number;
	to: number;
}

/**
 * Common shape. `R` is what a `[start, end)` offset range maps to:
 * DOM `Range[]` in reading view (one per text-node entry, so skipped elements
 * between entries are never painted), `{from, to}` in the editor.
 */
export interface TextMap<R> {
	/** Exactly the text sent in `read` (and later `append`s). */
	readonly text: string;
	/** Map a session-text range to on-screen ranges. Out-of-range input is clamped; empty result allowed. */
	rangeFor(start: number, end: number): R;
}

/** One rendered text node and where its text sits in the session text. */
export interface TextEntry {
	node: Text;
	start: number;
	length: number;
}

export interface ReadingViewTextMapOptions {
	/** Extra selectors to skip, on top of the defaults below. */
	skipSelectors?: string[];
	/**
	 * Whether every section of the note is rendered (drives `complete`).
	 * The DOM alone cannot tell; the plugin shell knows from
	 * `previewMode.renderer`. Default: always `true`.
	 */
	isComplete?: () => boolean;
}

/**
 * Reading view (rendered DOM). Built by a TreeWalker over
 * `view.previewMode.containerEl .markdown-preview-sizer`, skipping `pre`,
 * `.frontmatter`/`.metadata-container`, `.internal-embed`,
 * `.edit-block-button`, `.collapse-indicator`, `button`, `svg`, `img`,
 * `.math`, `[hidden]`/`[aria-hidden="true"]`. Separators: `\n\n` after blocks,
 * `\n` after `td`/`th`/`br` (port of PreviewMD `read-aloud-core.js`:
 * separatorFor, slicesFor, entryIndexAt, firstVisibleIndex, remapOffset,
 * exceedsUTF8).
 *
 * Obsidian virtualises long notes, so the map may be partial: `complete` is
 * false while sections remain unrendered, and `extend()` returns newly
 * rendered trailing text to send with `append`.
 */
export interface ReadingViewTextMap extends TextMap<Range[]> {
	readonly entries: readonly TextEntry[];
	readonly complete: boolean;
	/** Offset of the window selection's start if it lies inside the root, else `null`. */
	offsetForSelection(selection: Selection | null): number | null;
	/** Offset of the first entry visible in `scroller`'s viewport (0 if none). */
	firstVisibleOffset(scroller: Element): number;
	/** Offset for a DOM point (click-to-seek via `caretRangeFromPoint`), or `null` if not mapped. */
	offsetAt(node: Node, offsetInNode: number): number | null;
	/** Re-walk the root; returns text appended after the current end, or `null` if nothing new. */
	extend(): string | null;
	/** The element the map was built from. */
	readonly root: HTMLElement;
	/**
	 * Re-walk the root after a re-render and re-bind entries to the current
	 * text nodes, WITHOUT appending. Returns `inSync`: `true` when the rendered
	 * text still matches `text` (highlights keep working), `false` when the
	 * content changed — restart from `remapOffset(map.text, fresh.text, cur)`.
	 */
	remap(): boolean;
	/**
	 * Result of the last walk (build, `extend`, `remap`): `false` when a
	 * rendered section's text no longer matches the session text. Sections
	 * virtualised away above or below are not a mismatch.
	 */
	readonly inSync: boolean;
}

export type ReadingViewTextMapFactory = (root: HTMLElement, options?: ReadingViewTextMapOptions) => ReadingViewTextMap;

export interface EditorTextMapOptions {
	/** Offset where reading may start, e.g. after front matter (`frontmatterPosition.end.offset`). */
	bodyStart?: number;
}

/**
 * Live Preview / source mode. `text` = `editor.getValue()` (CM6 doc,
 * `\n`-normalised), so session offsets equal CM positions and `rangeFor`
 * is the identity `{from: start, to: end}` (clamped to the doc).
 */
export interface EditorTextMap extends TextMap<EditorRange> {
	readonly bodyStart: number;
	/** `posToOffset(getCursor('from'))` when the selection is non-empty, else `null`. */
	offsetForSelection(view: EditorView): number | null;
	/** First visible position, never before `bodyStart`. */
	firstVisibleOffset(view: EditorView): number;
}

export type EditorTextMapFactory = (view: EditorView, options?: EditorTextMapOptions) => EditorTextMap;
