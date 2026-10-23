/**
 * Long-text chunking (SPEC §8). Pieces concatenate to exactly the input, so
 * UTF-16 offsets stay global across `read` + `append`.
 */

/** SDK chunk budget in UTF-8 bytes (well under the 1 MiB frame cap). */
export const CHUNK_UTF8_BYTES = 512 * 1024;

/** UTF-8 byte length (lone surrogates count as U+FFFD, 3 bytes). */
export function utf8Length(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function codeUnitBytes(text: string, i: number): { bytes: number; units: number } {
	const c = text.charCodeAt(i);
	if (c < 0x80) return { bytes: 1, units: 1 };
	if (c < 0x800) return { bytes: 2, units: 1 };
	if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
		const d = text.charCodeAt(i + 1);
		if (d >= 0xdc00 && d <= 0xdfff) return { bytes: 4, units: 2 };
	}
	return { bytes: 3, units: 1 };
}

/**
 * Split `text` into pieces of at most `maxUTF8` bytes each, cutting right
 * after the last `\n\n` in the window, else the last `\n`, else the last
 * space, else at the byte budget (never inside a surrogate pair).
 */
export function chunkText(text: string, maxUTF8: number = CHUNK_UTF8_BYTES): string[] {
	const budget = Math.max(4, Math.floor(maxUTF8));
	if (utf8Length(text) <= budget) return [text];
	const out: string[] = [];
	let start = 0;
	while (start < text.length) {
		// Furthest UTF-16 index `limit` such that bytes(text[start..limit)) <= budget.
		let bytes = 0;
		let limit = start;
		while (limit < text.length) {
			const { bytes: b, units } = codeUnitBytes(text, limit);
			if (bytes + b > budget) break;
			bytes += b;
			limit += units;
		}
		if (limit >= text.length) {
			out.push(text.slice(start));
			break;
		}
		if (limit === start) limit = start + codeUnitBytes(text, start).units; // cannot happen with budget >= 4
		const window = text.slice(start, limit);
		let cut = limit;
		for (const sep of ["\n\n", "\n", " "]) {
			const at = window.lastIndexOf(sep);
			if (at >= 0) {
				const end = at + sep.length;
				if (end > 0) {
					cut = start + end;
					break;
				}
			}
		}
		out.push(text.slice(start, cut));
		start = cut;
	}
	return out;
}
