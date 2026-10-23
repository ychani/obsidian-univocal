export type {
	EditorHighlighter,
	EditorHighlighterFactory,
	Highlighter,
	ReadingViewHighlighter,
	ReadingViewHighlighterFactory,
	ReadingViewHighlighterOptions,
	PaintedCount,
} from "./types";
export { SENTENCE_HIGHLIGHT, WORD_HIGHLIGHT } from "./types";
export { createReadingViewHighlighter } from "./readingView";
export {
	createEditorHighlighter,
	currentHighlight,
	dispatchHighlight,
	paintedRangeCount,
	highlightEffects,
	univocalHighlightEffect,
	univocalHighlightExtension,
	univocalHighlightField,
} from "./editor";
export type { HighlightState, HighlightUpdate } from "./editor";
export { createAutoScroller, editorPosRect } from "./autoScroll";
export type { AutoScroller, AutoScrollerOptions, FollowTarget, RectLike } from "./autoScroll";
export { setHighlightStyle, UNDERLINE_STYLE_CLASS } from "./style";
export type { HighlightStyle } from "./style";
export { readingTextMap, readingHighlighter, editorTextMap, editorHighlighter, editorExtensions, univocalFactories } from "./factories";
