/**
 * Pure text helpers (no DOM), ported from PreviewMD `read-aloud-core.js`.
 *
 * All offsets are UTF-16 code units — what JavaScript string indices already
 * are, and what the Univocal protocol uses (SPEC §7).
 */

export function clamp(n: number, lo: number, hi: number): number {
	return n < lo ? lo : n > hi ? hi : n;
}

function isHigh(c: number): boolean {
	return c >= 0xd800 && c <= 0xdbff;
}

function isLow(c: number): boolean {
	return c >= 0xdc00 && c <= 0xdfff;
}

/** Never leave an offset between the halves of a surrogate pair. */
export function snapToCodePoint(text: string, i: number): number {
	if (i > 0 && i < text.length && isLow(text.charCodeAt(i)) && isHigh(text.charCodeAt(i - 1))) return i - 1;
	return i;
}

function commonPrefixLength(a: string, b: string): number {
	const n = Math.min(a.length, b.length);
	let i = 0;
	while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
	return i;
}

function commonSuffixLength(a: string, b: string, max: number): number {
	let i = 0;
	while (i < max && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) i++;
	return i;
}

const TERMINAL = /[.!?…。！？]/;
const CLOSER = /["'”’)\]]/;
const SPACE = /[ \t ]/;

/**
 * Start of the sentence containing `pos`, looking back at most `maxBack`
 * units: just after a newline, or after sentence punctuation (optionally
 * followed by a closing quote/bracket) and a space. The text start counts as
 * a boundary. With none in reach, `pos` itself.
 */
export function sentenceStartBefore(text: string, pos: number, maxBack: number): number {
	pos = clamp(pos, 0, text.length);
	const limit = Math.max(0, pos - maxBack);
	for (let i = pos; i > limit; i--) {
		const ch = text.charAt(i - 1);
		if (ch === "\n") return i;
		if (SPACE.test(ch) && i >= 2) {
			let j = i - 2;
			if (j > 0 && CLOSER.test(text.charAt(j))) j--;
			if (TERMINAL.test(text.charAt(j))) return i;
		}
	}
	return limit === 0 ? 0 : pos;
}

/**
 * Where to resume after the text changed from `oldText` to `newText` while
 * reading at `cur` (the start of the current sentence). Unchanged prefix →
 * same offset; unchanged suffix → shifted by the length difference; the edit
 * touched the current sentence → the start of the sentence around the first
 * changed character.
 */
export function remapOffset(oldText: string, newText: string, cur: number): number {
	const oldLen = oldText.length;
	const newLen = newText.length;
	cur = clamp(cur | 0, 0, oldLen);
	const p = commonPrefixLength(oldText, newText);
	const q = commonSuffixLength(oldText, newText, Math.min(oldLen, newLen) - p);
	let r: number;
	if (cur < p) r = cur;
	else if (cur >= oldLen - q) r = cur + (newLen - oldLen);
	else r = sentenceStartBefore(newText, snapToCodePoint(newText, p), 300);
	return snapToCodePoint(newText, clamp(r, 0, newLen));
}

/**
 * The newlines to append so `text` ends with at least `n` (1 or 2) of them
 * (block separators). Nothing at the very start of the text.
 */
export function separatorFor(text: string, n: number): string {
	if (!text) return "";
	let have = 0;
	while (have < n && text.charCodeAt(text.length - 1 - have) === 10) have++;
	return "\n\n".slice(0, Math.max(0, n - have));
}

export interface Span {
	start: number;
	length: number;
}

/** Index of the last entry starting at or before `offset`, or -1. Entries sorted by start, non-overlapping. */
export function entryIndexAt(entries: readonly Span[], offset: number): number {
	let lo = 0;
	let hi = entries.length - 1;
	let found = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (entries[mid]!.start <= offset) {
			found = mid;
			lo = mid + 1;
		} else hi = mid - 1;
	}
	return found;
}

export interface Slice {
	index: number;
	/** Local to the entry. */
	start: number;
	end: number;
}

/** The parts of the entries covered by `[start, end)`. Separators between entries map to nothing. */
export function slicesFor(entries: readonly Span[], start: number, end: number): Slice[] {
	const out: Slice[] = [];
	if (!(end > start)) return out;
	let i = entryIndexAt(entries, start);
	if (i < 0) i = 0;
	for (; i < entries.length; i++) {
		const e = entries[i]!;
		if (e.start >= end) break;
		const a = Math.max(start, e.start) - e.start;
		const b = Math.min(end, e.start + e.length) - e.start;
		if (b > a) out.push({ index: i, start: a, end: b });
	}
	return out;
}

/** Comfort band for scroll-follow, as fractions of the viewport height. */
export const COMFORT_TOP = 0.25;
export const COMFORT_BOTTOM = 0.75;
/** Where a word outside the band is brought to. */
export const FOLLOW_ANCHOR = 0.4;

/**
 * Scroll-follow: the new scrollTop that puts a target at (`top`, `height`)
 * — relative to the viewport's top edge — at 40 % of the viewport, or `null`
 * while its centre is still inside the 25 %–75 % comfort band.
 */
export function followScrollTop(top: number, height: number, scrollTop: number, viewportHeight: number): number | null {
	const centre = top + height / 2;
	if (centre >= viewportHeight * COMFORT_TOP && centre <= viewportHeight * COMFORT_BOTTOM) return null;
	return Math.max(0, Math.round(scrollTop + centre - viewportHeight * FOLLOW_ANCHOR));
}

/**
 * `tops`/`bottoms` are viewport-relative edges of candidate blocks in
 * document order: the first whose top edge is on screen, else the first still
 * partly on screen, else -1.
 */
export function firstVisibleIndex(tops: readonly number[], bottoms: readonly number[], viewportHeight: number): number {
	for (let i = 0; i < tops.length; i++) {
		if (tops[i]! >= 0 && tops[i]! < viewportHeight) return i;
	}
	for (let j = 0; j < bottoms.length; j++) {
		if (bottoms[j]! > 0 && tops[j]! < viewportHeight) return j;
	}
	return -1;
}

/** The smallest i in [0, n) with `pred(i)` true, for a false-then-true predicate; `n` when never true. */
export function lowerBound(n: number, pred: (i: number) => boolean): number {
	let lo = 0;
	let hi = n;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (pred(mid)) hi = mid;
		else lo = mid + 1;
	}
	return lo;
}

/** UTF-8 byte length of `text` (lone surrogates count as 3, like U+FFFD). */
export function utf8Length(text: string): number {
	let bytes = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c < 0x80) bytes += 1;
		else if (c < 0x800) bytes += 2;
		else if (isHigh(c) && i + 1 < text.length && isLow(text.charCodeAt(i + 1))) {
			bytes += 4;
			i++;
		} else bytes += 3;
	}
	return bytes;
}

/** True when the UTF-8 encoding of `text` is longer than `limit` bytes. */
export function exceedsUTF8(text: string, limit: number): boolean {
	if (text.length * 3 <= limit) return false;
	if (text.length > limit) return true;
	let bytes = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c < 0x80) bytes += 1;
		else if (c < 0x800) bytes += 2;
		else if (isHigh(c) && i + 1 < text.length && isLow(text.charCodeAt(i + 1))) {
			bytes += 4;
			i++;
		} else bytes += 3;
		if (bytes > limit) return true;
	}
	return false;
}

/** Chunk size for `read{more:true}` + `append` (plan §2). */
export const DEFAULT_CHUNK_BYTES = 512 * 1024;

/**
 * Split `text` into consecutive chunks of at most `maxBytes` UTF-8 bytes,
 * cutting just after a `\n\n` where possible, else after a `\n`, else at a
 * code-point boundary. `chunks.join("") === text`; never splits a surrogate pair.
 */
export function chunkText(text: string, maxBytes: number = DEFAULT_CHUNK_BYTES): string[] {
	if (maxBytes < 4) throw new RangeError("maxBytes must be at least 4");
	const out: string[] = [];
	let pos = 0;
	while (pos < text.length) {
		// Largest end such that text.slice(pos, end) fits.
		let bytes = 0;
		let end = pos;
		while (end < text.length) {
			const c = text.charCodeAt(end);
			let w: number;
			let step = 1;
			if (c < 0x80) w = 1;
			else if (c < 0x800) w = 2;
			else if (isHigh(c) && end + 1 < text.length && isLow(text.charCodeAt(end + 1))) {
				w = 4;
				step = 2;
			} else w = 3;
			if (bytes + w > maxBytes) break;
			bytes += w;
			end += step;
		}
		if (end >= text.length) {
			out.push(text.slice(pos));
			break;
		}
		const window = text.slice(pos, end);
		let cut = window.lastIndexOf("\n\n");
		if (cut > 0) cut += 2;
		else {
			cut = window.lastIndexOf("\n");
			cut = cut > 0 ? cut + 1 : window.length;
		}
		out.push(text.slice(pos, pos + cut));
		pos += cut;
	}
	return out;
}
