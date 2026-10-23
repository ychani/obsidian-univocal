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

export interface Highlighter<R> {
	/** Replace the word range (`null` = none). */
	setWord(range: R | null): void;
	/** Replace the sentence range (`null` = none). */
	setSentence(range: R | null): void;
	/** Remove both ranges. Idempotent. */
	clear(): void;
	/** `clear()` + release all resources. Further calls are no-ops. */
	dispose(): void;
}

/**
 * Reading view: CSS Custom Highlight API on `doc` (the view's ownerDocument —
 * popout windows have their own `CSS.highlights` registry). Highlight names
 * `univocal-word` / `univocal-sentence`, styled in `styles.css` via
 * `::highlight(...)`.
 */
export type ReadingViewHighlighter = Highlighter<Range[]>;
export type ReadingViewHighlighterFactory = (doc: Document) => ReadingViewHighlighter;

/**
 * Editor: a `StateField<DecorationSet>` driven by a `StateEffect<{word, sentence}>`
 * using `Decoration.mark`; decorations are mapped through document changes.
 */
export type EditorHighlighter = Highlighter<EditorRange>;
export type EditorHighlighterFactory = (view: EditorView) => EditorHighlighter;
