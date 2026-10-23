import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { EditorView } from "@codemirror/view";
import {
	createEditorHighlighter,
	currentHighlight,
	highlightEffects,
	univocalHighlightEffect,
	univocalHighlightExtension,
	univocalHighlightField,
} from "../../src/highlight/editor";
import type { EditorHighlighterFactory } from "../../src/highlight/types";

const factory: EditorHighlighterFactory = createEditorHighlighter;

const DOC = "The quick brown fox jumps over the lazy dog. It was not amused 😀. 日本語の文。";

function decos(state: EditorState): { from: number; to: number; cls: string }[] {
	const set: DecorationSet = state.field(univocalHighlightField).decorations;
	const out: { from: number; to: number; cls: string }[] = [];
	set.between(0, state.doc.length, (from, to, d) => {
		out.push({ from, to, cls: String(d.spec.class) });
	});
	return out;
}

const count = (state: EditorState, cls: string) => decos(state).filter((d) => d.cls === cls).length;

function words(text: string): { from: number; to: number }[] {
	return [...text.matchAll(/[^\s.。]+/gu)].map((m) => ({ from: m.index!, to: m.index! + m[0].length }));
}

describe("editor highlighter (CM6 StateField)", () => {
	const fresh = () => EditorState.create({ doc: DOC, extensions: univocalHighlightExtension });

	it("holds at most one word decoration after many effects", () => {
		let state = fresh();
		const ws = words(DOC);
		for (let i = 0; i < 200; i++) {
			const w = ws[i % ws.length]!;
			const effects = [univocalHighlightEffect.of({ word: w })];
			if (i % 7 === 0) effects.push(univocalHighlightEffect.of({ sentence: { from: 0, to: 44 } }));
			state = state.update({ effects }).state;
			expect(count(state, "univocal-word")).toBeLessThanOrEqual(1);
			expect(count(state, "univocal-sentence")).toBeLessThanOrEqual(1);
		}
		const last = ws[199 % ws.length]!;
		expect(decos(state).find((d) => d.cls === "univocal-word")).toEqual({ ...last, cls: "univocal-word" });
		expect(count(state, "univocal-sentence")).toBe(1);
	});

	it("several effects in one transaction still leave one word", () => {
		const ws = words(DOC);
		const state = fresh().update({ effects: ws.map((w) => univocalHighlightEffect.of({ word: w })) }).state;
		expect(count(state, "univocal-word")).toBe(1);
		expect(currentHighlight(state).word).toEqual(ws[ws.length - 1]);
	});

	it("clear (null/null) leaves zero; undefined keeps the other range", () => {
		let state = fresh().update({ effects: univocalHighlightEffect.of({ word: { from: 4, to: 9 }, sentence: { from: 0, to: 44 } }) }).state;
		state = state.update({ effects: univocalHighlightEffect.of({ word: null }) }).state;
		expect(count(state, "univocal-word")).toBe(0);
		expect(count(state, "univocal-sentence")).toBe(1);
		state = state.update({ effects: univocalHighlightEffect.of({ word: null, sentence: null }) }).state;
		expect(decos(state)).toEqual([]);
	});

	it("across two sessions nothing from session 1 remains", () => {
		let state = fresh();
		for (const w of words(DOC).slice(0, 6)) state = state.update({ effects: univocalHighlightEffect.of({ word: w, sentence: { from: 0, to: 44 } }) }).state;
		state = state.update({ effects: univocalHighlightEffect.of({ word: null, sentence: null }) }).state;
		const i = DOC.indexOf("It");
		state = state.update({ effects: univocalHighlightEffect.of({ word: { from: i, to: i + 2 } }) }).state;
		expect(decos(state)).toEqual([{ from: i, to: i + 2, cls: "univocal-word" }]);
	});

	it("maps ranges through document changes and drops a deleted word", () => {
		let state = fresh().update({ effects: univocalHighlightEffect.of({ word: { from: 4, to: 9 }, sentence: { from: 0, to: 44 } }) }).state;
		state = state.update({ changes: { from: 0, insert: ">> " } }).state;
		expect(currentHighlight(state)).toEqual({ word: { from: 7, to: 12 }, sentence: { from: 3, to: 47 } });
		expect(state.doc.sliceString(7, 12)).toBe("quick");
		expect(decos(state).find((d) => d.cls === "univocal-word")).toMatchObject({ from: 7, to: 12 });
		state = state.update({ changes: { from: 5, to: 14 } }).state; // deletes "quick" and around it
		expect(currentHighlight(state).word).toBeNull();
		expect(count(state, "univocal-word")).toBe(0);
		expect(count(state, "univocal-sentence")).toBe(1);
	});

	it("clamps effect ranges to the document", () => {
		const state = fresh().update({ effects: univocalHighlightEffect.of({ word: { from: DOC.length - 1, to: DOC.length + 50 } }) }).state;
		expect(currentHighlight(state).word).toEqual({ from: DOC.length - 1, to: DOC.length });
		const empty = fresh().update({ effects: univocalHighlightEffect.of({ word: { from: 5, to: 5 } }) }).state;
		expect(currentHighlight(empty).word).toBeNull();
	});

	it("highlightEffects installs the field into a state that lacks it", () => {
		const bare = EditorState.create({ doc: DOC });
		expect(bare.field(univocalHighlightField, false)).toBeUndefined();
		const state = bare.update({ effects: highlightEffects(bare, { word: { from: 0, to: 3 } }) }).state;
		expect(currentHighlight(state).word).toEqual({ from: 0, to: 3 });
		expect(count(state, "univocal-word")).toBe(1);
		// Once installed, no second copy is appended.
		expect(highlightEffects(state, { word: null })).toHaveLength(1);
	});

	it("the EditorView highlighter dispatches with clear/replace semantics", () => {
		const parent = document.createElement("div");
		document.body.appendChild(parent);
		const view = new EditorView({ state: EditorState.create({ doc: DOC }), parent });
		try {
			const h = factory(view);
			for (const w of words(DOC)) h.setWord(w);
			h.setSentence({ from: 0, to: 44 });
			expect(count(view.state, "univocal-word")).toBe(1);
			expect(view.contentDOM.querySelectorAll(".univocal-word")).toHaveLength(1);
			h.clear();
			expect(decos(view.state)).toEqual([]);
			expect(view.contentDOM.querySelectorAll(".univocal-word, .univocal-sentence")).toHaveLength(0);
			h.setWord({ from: 0, to: 3 });
			h.dispose();
			expect(decos(view.state)).toEqual([]);
			h.setWord({ from: 0, to: 3 }); // no-op after dispose
			expect(decos(view.state)).toEqual([]);
		} finally {
			view.destroy();
		}
	});
});

describe("shell factories", () => {
	it("exports the five ShellFactories members and counts painted ranges", async () => {
		const f = await import("../../src/highlight/factories");
		expect(Object.keys(f.univocalFactories).sort()).toEqual(
			["editorExtensions", "editorHighlighter", "editorTextMap", "readingHighlighter", "readingTextMap"],
		);
		const parent = document.createElement("div");
		document.body.appendChild(parent);
		const view = new EditorView({ state: EditorState.create({ doc: DOC, extensions: f.editorExtensions }), parent });
		try {
			const map = f.editorTextMap(view, { bodyStart: 4 });
			expect(map.bodyStart).toBe(4);
			const h = f.editorHighlighter(view);
			for (const w of words(DOC)) h.setWord(map.rangeFor(w.from, w.to));
			h.setSentence(map.rangeFor(0, 44));
			expect(h.paintedRangeCount?.()).toEqual({ word: 1, sentence: 1 });
			h.dispose();
			expect(h.paintedRangeCount?.()).toEqual({ word: 0, sentence: 0 });
		} finally {
			view.destroy();
		}
	});
});
