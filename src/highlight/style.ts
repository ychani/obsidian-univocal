/**
 * Highlight style toggle. `background` (default) paints the word with the
 * accent colour; `underline` is for themes whose own backgrounds (e.g. on
 * `.cm-line` or `mark`) clash with it. The class goes on `<body>`, so it
 * applies to `::highlight(...)`, editor marks and the `<mark>` fallback alike.
 */
export type HighlightStyle = "background" | "underline";

export const UNDERLINE_STYLE_CLASS = "univocal-highlight-underline";

export function setHighlightStyle(doc: Document, style: HighlightStyle): void {
	doc.body?.classList.toggle(UNDERLINE_STYLE_CLASS, style === "underline");
}
