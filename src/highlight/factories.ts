/**
 * The factories the plugin shell wires in (`ShellFactories` in main.ts):
 *
 *   import { univocalFactories } from "./highlight/factories";
 *   const FACTORIES = { ...connectFactories, ...univocalFactories };
 *   this.registerEditorExtension(univocalFactories.editorExtensions);
 */
import type { Extension } from "@codemirror/state";
import { createEditorTextMap } from "../textmap/editor";
import { createReadingViewTextMap } from "../textmap/readingView";
import type { EditorTextMapFactory, ReadingViewTextMapFactory } from "../textmap/types";
import { createEditorHighlighter, editorExtensions as cmExtensions } from "./editor";
import { createReadingViewHighlighter } from "./readingView";
import type { EditorHighlighterFactory, ReadingViewHighlighterFactory } from "./types";

/** `(root, options?) => ReadingViewTextMap` over `.markdown-preview-sizer`. */
export const readingTextMap: ReadingViewTextMapFactory = createReadingViewTextMap;
/** `(doc, options?) => ReadingViewHighlighter` — CSS Custom Highlight API, `<mark>` fallback. */
export const readingHighlighter: ReadingViewHighlighterFactory = createReadingViewHighlighter;
/** `(view, { bodyStart }?) => EditorTextMap` — identity over the CM6 doc. */
export const editorTextMap: EditorTextMapFactory = createEditorTextMap;
/** `(view) => EditorHighlighter` — dispatches into the StateField. */
export const editorHighlighter: EditorHighlighterFactory = createEditorHighlighter;
/** Register once at load: `plugin.registerEditorExtension(editorExtensions)`. */
export const editorExtensions: Extension[] = cmExtensions;

export const univocalFactories = {
	readingTextMap,
	readingHighlighter,
	editorTextMap,
	editorHighlighter,
	editorExtensions,
} as const;
