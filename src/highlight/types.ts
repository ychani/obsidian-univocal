/**
 * Word/sentence highlighting (plan §3).
 *
 * INVARIANT (PreviewMD shipped the violation twice): at any moment there is
 * EXACTLY ONE live word range and EXACTLY ONE live sentence range (or none).
 * Each `setWord` / `setSentence` call REPLACES the previous range — it never
 * adds to it. `null` removes it. Tests must assert that exactly one word range
 * is painted after N events, within one session and across sessions.
 *
 * Lifecycle rules for callers:
 * - `clear()` runs on `ended` (any reason), active-leaf-change, file-open,
 *   layout-change, re-render and plugin unload.
 * - Activating a new session always calls `clear()` first; a monotonically
 *   increasing session token drops late events from older sessions.
 * - `dispose()` clears AND deletes registry entries (`CSS.highlights.delete`)
 *   / detaches the editor extension's state; the instance is dead afterwards.
 */
import type { EditorView } from "@codemirror/view";
import type { EditorRange } from "../textmap/types";

/** Live ranges actually painted right now (QA / dev status file). */
export interface PaintedCount {
	word: number;
	sentence: number;
}

export interface Highlighter<R> {
	/** Replace the word range (`null` = none). */
	setWord(range: R | null): void;
	/** Replace the sentence range (`null` = none). */
	setSentence(range: R | null): void;
	/** Remove both ranges. Idempotent. */
	clear(): void;
	/** `clear()` + release all resources. Further calls are no-ops. */
	dispose(): void;
	/**
	 * What is painted right now: `CSS.highlights` Range counts, `<mark>`
	 * elements, or editor decorations. With single-text-node words this is
	 * at most 1 each — the invariant QA checks.
	 */
	paintedRangeCount?(): PaintedCount;
}

/**
 * Reading view: CSS Custom Highlight API on `doc` (the view's ownerDocument —
 * popout windows have their own `CSS.highlights` registry). Highlight names
 * `univocal-word` / `univocal-sentence`, styled in `styles.css` via
 * `::highlight(...)`.
 */
export type ReadingViewHighlighter = Highlighter<Range[]> & {
	/**
	 * `css-highlight`: CSS Custom Highlight API (Obsidian's Electron always has it).
	 * `mark`: fallback that wraps the ranges in `<mark class="univocal-word">` /
	 * `<mark class="univocal-sentence">` and fully unwraps on every set/clear.
	 */
	readonly mode: "css-highlight" | "mark";
};

export interface ReadingViewHighlighterOptions {
	/** Use the `<mark>` fallback even when `CSS.highlights` exists (QA). */
	forceFallback?: boolean;
}

export type ReadingViewHighlighterFactory = (doc: Document, options?: ReadingViewHighlighterOptions) => ReadingViewHighlighter;

/**
 * Editor: a `StateField<DecorationSet>` driven by a `StateEffect<{word, sentence}>`
 * using `Decoration.mark`; decorations are mapped through document changes.
 */
export type EditorHighlighter = Highlighter<EditorRange>;
export type EditorHighlighterFactory = (view: EditorView) => EditorHighlighter;

/** Highlight names (CSS Custom Highlight API) and class names (editor marks, `<mark>` fallback). */
export const WORD_HIGHLIGHT = "univocal-word";
export const SENTENCE_HIGHLIGHT = "univocal-sentence";
