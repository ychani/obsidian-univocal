/**
 * Editor (CM6) highlighter: a `StateField` holding at most one word and one
 * sentence range, driven by a `StateEffect`. Each effect REPLACES the ranges
 * it names (`undefined` = keep, `null` = remove) — same semantics as the
 * reading view. Ranges are mapped through document changes; a range that
 * collapses to nothing is dropped.
 */
import { StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import type { EditorRange } from "../textmap/types";
import { SENTENCE_HIGHLIGHT, WORD_HIGHLIGHT, type EditorHighlighter, type PaintedCount } from "./types";

export interface HighlightUpdate {
	/** `undefined` keeps the current word, `null` removes it. */
	word?: EditorRange | null;
	/** `undefined` keeps the current sentence, `null` removes it. */
	sentence?: EditorRange | null;
}

export interface HighlightState {
	readonly word: EditorRange | null;
	readonly sentence: EditorRange | null;
	readonly decorations: DecorationSet;
}

const wordMark = Decoration.mark({ class: WORD_HIGHLIGHT });
const sentenceMark = Decoration.mark({ class: SENTENCE_HIGHLIGHT });

function mapRange(r: EditorRange | null | undefined, map: (pos: number, assoc: number) => number): EditorRange | null | undefined {
	if (!r) return r;
	const from = map(r.from, 1);
	const to = Math.max(from, map(r.to, -1));
	return to > from ? { from, to } : null;
}

/** The effect: replace the word and/or sentence range. */
export const univocalHighlightEffect = StateEffect.define<HighlightUpdate>({
	map: (value, mapping) => ({
		word: mapRange(value.word, (p, a) => mapping.mapPos(p, a)),
		sentence: mapRange(value.sentence, (p, a) => mapping.mapPos(p, a)),
	}),
});

function clampRange(r: EditorRange | null, len: number): EditorRange | null {
	if (!r) return null;
	const from = Math.min(Math.max(0, Math.floor(r.from)), len);
	const to = Math.min(Math.max(from, Math.floor(r.to)), len);
	return to > from ? { from, to } : null;
}

function build(word: EditorRange | null, sentence: EditorRange | null): HighlightState {
	const ranges = [];
	if (sentence) ranges.push(sentenceMark.range(sentence.from, sentence.to));
	if (word) ranges.push(wordMark.range(word.from, word.to));
	return { word, sentence, decorations: Decoration.set(ranges, true) };
}

const EMPTY = build(null, null);

/** At most one word and one sentence decoration, ever. */
export const univocalHighlightField = StateField.define<HighlightState>({
	create: () => EMPTY,
	update(value, tr) {
		let word = value.word;
		let sentence = value.sentence;
		let changed = false;
		if (tr.docChanged) {
			word = mapRange(word, (p, a) => tr.changes.mapPos(p, a)) ?? null;
			sentence = mapRange(sentence, (p, a) => tr.changes.mapPos(p, a)) ?? null;
			changed = true;
		}
		for (const e of tr.effects) {
			if (!e.is(univocalHighlightEffect)) continue;
			const len = tr.newDoc.length;
			if (e.value.word !== undefined) word = clampRange(e.value.word, len);
			if (e.value.sentence !== undefined) sentence = clampRange(e.value.sentence, len);
			changed = true;
		}
		if (!changed) return value;
		return word || sentence ? build(word, sentence) : EMPTY;
	},
	provide: (f) => EditorView.decorations.from(f, (v) => v.decorations),
});

/** Register with `plugin.registerEditorExtension(univocalHighlightExtension)`. */
export const univocalHighlightExtension: Extension = [univocalHighlightField];

/** Same, as the array `plugin.registerEditorExtension()` takes. */
export const editorExtensions: Extension[] = [univocalHighlightField];

/** The current (mapped) ranges, e.g. to restart from the remapped sentence after an edit. */
export function currentHighlight(state: EditorState): { word: EditorRange | null; sentence: EditorRange | null } {
	const v = state.field(univocalHighlightField, false);
	return { word: v?.word ?? null, sentence: v?.sentence ?? null };
}

/** Decorations currently in the field: at most 1 word and 1 sentence. */
export function paintedRangeCount(state: EditorState): PaintedCount {
	const v = state.field(univocalHighlightField, false);
	const out = { word: 0, sentence: 0 };
	v?.decorations.between(0, state.doc.length, (_from, _to, d) => {
		if (d.spec.class === WORD_HIGHLIGHT) out.word++;
		else if (d.spec.class === SENTENCE_HIGHLIGHT) out.sentence++;
	});
	return out;
}

/** The `effects` (plus the field itself when the state lacks it) for one update. */
export function highlightEffects(state: EditorState, update: HighlightUpdate): StateEffect<unknown>[] {
	const effects: StateEffect<unknown>[] = [];
	if (state.field(univocalHighlightField, false) === undefined) {
		effects.push(StateEffect.appendConfig.of(univocalHighlightExtension));
	}
	effects.push(univocalHighlightEffect.of(update));
	return effects;
}

/** Dispatch an update to `view`. Installs the field on the fly if the view does not have it. */
export function dispatchHighlight(view: EditorView, update: HighlightUpdate): void {
	view.dispatch({ effects: highlightEffects(view.state, update) });
}

class CmHighlighter implements EditorHighlighter {
	private view: EditorView | null;

	constructor(view: EditorView) {
		this.view = view;
	}

	private send(update: HighlightUpdate): void {
		const view = this.view;
		if (!view) return;
		try {
			dispatchHighlight(view, update);
		} catch {
			// destroyed view: nothing to paint
		}
	}

	setWord(range: EditorRange | null): void {
		this.send({ word: range });
	}

	setSentence(range: EditorRange | null): void {
		this.send({ sentence: range });
	}

	clear(): void {
		const view = this.view;
		if (!view) return;
		const v = view.state.field(univocalHighlightField, false);
		if (!v || (!v.word && !v.sentence)) return;
		this.send({ word: null, sentence: null });
	}

	dispose(): void {
		this.clear();
		this.view = null;
	}

	paintedRangeCount(): PaintedCount {
		return this.view ? paintedRangeCount(this.view.state) : { word: 0, sentence: 0 };
	}
}

export function createEditorHighlighter(view: EditorView): EditorHighlighter {
	return new CmHighlighter(view);
}
