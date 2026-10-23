import { describe, expect, it } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { bodyStartFor, createEditorTextMap, editorTextMapFromText } from "../../src/textmap/editor";
import type { EditorTextMapFactory } from "../../src/textmap/types";

const factory: EditorTextMapFactory = createEditorTextMap;

const NOTE = "---\ntitle: Hi\ntags: [a]\n---\n\n# Heading\n\nBody 😀 text.\n";

describe("bodyStartFor", () => {
	it("uses Obsidian's frontmatterPosition and skips the blank lines after it", () => {
		const end = NOTE.indexOf("---", 3) + 3; // Obsidian: end of the closing fence
		expect(bodyStartFor(NOTE, { end: { offset: end } })).toBe(NOTE.indexOf("# Heading"));
	});
	it("recognises front matter itself without the cache", () => {
		expect(bodyStartFor(NOTE)).toBe(NOTE.indexOf("# Heading"));
		expect(bodyStartFor("---\na: 1\n...\nText")).toBe("---\na: 1\n...\n".length);
	});
	it("is 0 without front matter", () => {
		expect(bodyStartFor("# Just a note\n")).toBe(0);
		expect(bodyStartFor("--- not front matter\n")).toBe(0);
		expect(bodyStartFor("")).toBe(0);
	});
});

describe("editor text map", () => {
	it("is the identity mapping, clamped", () => {
		const map = editorTextMapFromText(NOTE, { bodyStart: bodyStartFor(NOTE) });
		expect(map.text).toBe(NOTE);
		const i = NOTE.indexOf("😀");
		expect(map.rangeFor(i, i + 2)).toEqual({ from: i, to: i + 2 });
		expect(map.rangeFor(-5, 3)).toEqual({ from: 0, to: 3 });
		expect(map.rangeFor(5, 2)).toEqual({ from: 5, to: 5 });
		expect(map.rangeFor(0, 10_000)).toEqual({ from: 0, to: NOTE.length });
		const r = map.rangeFor(i, i + 2);
		expect(map.text.slice(r.from, r.to)).toBe("😀");
	});

	it("reads the CM doc and the selection from an EditorView", () => {
		const parent = document.createElement("div");
		document.body.appendChild(parent);
		const view = new EditorView({ state: EditorState.create({ doc: NOTE }), parent });
		try {
			const map = factory(view, { bodyStart: bodyStartFor(NOTE) });
			expect(map.text).toBe(view.state.doc.toString());
			expect(map.bodyStart).toBe(NOTE.indexOf("# Heading"));
			expect(map.offsetForSelection(view)).toBeNull();
			const from = NOTE.indexOf("Body");
			view.dispatch({ selection: EditorSelection.range(from, from + 4) });
			expect(map.offsetForSelection(view)).toBe(from);
			// Not laid out in jsdom: never before the body.
			expect(map.firstVisibleOffset(view)).toBeGreaterThanOrEqual(map.bodyStart);
		} finally {
			view.destroy();
		}
	});
});
