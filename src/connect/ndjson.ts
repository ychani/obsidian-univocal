/**
 * NDJSON framing (SPEC §3.1): one JSON object per `\n`-terminated UTF-8 line.
 * Tolerant reader: `\r\n` accepted, blank lines skipped, malformed lines and
 * non-object values reported and skipped (the client never resynchronises
 * mid-line because lines are split on raw 0x0A bytes before decoding).
 */
import { UnivocalError } from "./errors";

/** 1 MiB including the newline (SPEC §3.1). */
export const DEFAULT_MAX_FRAME_BYTES = 1_048_576;

export type WireMessage = Record<string, unknown> & { type: string };

export interface DecoderHandlers {
	message(msg: WireMessage): void;
	/** A line that was not a JSON object with a string `type`. Byte length only — never content. */
	malformed?(byteLength: number): void;
	/** A line exceeded `maxLineBytes`; the caller should close the connection. */
	overflow?(byteLength: number): void;
}

export class NdjsonDecoder {
	private chunks: Buffer[] = [];
	private buffered = 0;
	private dead = false;

	constructor(
		private readonly handlers: DecoderHandlers,
		/** Includes the trailing newline. */
		public maxLineBytes: number = DEFAULT_MAX_FRAME_BYTES,
	) {}

	push(data: Buffer | string): void {
		if (this.dead) return;
		let buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
		while (buf.length > 0) {
			const nl = buf.indexOf(0x0a);
			if (nl === -1) {
				this.chunks.push(buf);
				this.buffered += buf.length;
				if (this.buffered > this.maxLineBytes) this.fail(this.buffered);
				return;
			}
			const head = buf.subarray(0, nl);
			const lineLength = this.buffered + head.length + 1;
			if (lineLength > this.maxLineBytes) {
				this.fail(lineLength);
				return;
			}
			const line = this.buffered === 0 ? head : Buffer.concat([...this.chunks, head], this.buffered + head.length);
			this.chunks = [];
			this.buffered = 0;
			buf = buf.subarray(nl + 1);
			this.emitLine(line);
			if (this.dead) return;
		}
	}

	/** Drop any partial line (e.g. on reconnect). */
	reset(): void {
		this.chunks = [];
		this.buffered = 0;
		this.dead = false;
	}

	private fail(byteLength: number): void {
		this.dead = true;
		this.chunks = [];
		this.buffered = 0;
		this.handlers.overflow?.(byteLength);
	}

	private emitLine(raw: Buffer): void {
		let end = raw.length;
		if (end > 0 && raw[end - 1] === 0x0d) end -= 1;
		const text = raw.toString("utf8", 0, end);
		if (text.trim() === "") return;
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			this.handlers.malformed?.(raw.length);
			return;
		}
		if (value === null || typeof value !== "object" || Array.isArray(value) || typeof (value as { type?: unknown }).type !== "string") {
			this.handlers.malformed?.(raw.length);
			return;
		}
		this.handlers.message(value as WireMessage);
	}
}

/**
 * Serialise one message as a frame. Throws `textTooLarge` when the frame
 * (including the newline) exceeds `limit`. `JSON.stringify` escapes every raw
 * newline and lone surrogate, so a frame never contains a raw 0x0A.
 */
export function encodeFrame(msg: Record<string, unknown>, limit: number = DEFAULT_MAX_FRAME_BYTES): Buffer {
	const frame = Buffer.from(JSON.stringify(msg) + "\n", "utf8");
	if (frame.length > limit) {
		const sid = typeof msg.sessionId === "string" ? msg.sessionId : undefined;
		throw new UnivocalError("textTooLarge", `A ${frame.length}-byte frame exceeds the ${limit}-byte limit.`, { sessionId: sid });
	}
	return frame;
}
