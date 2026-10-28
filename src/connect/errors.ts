import type { ConnectError, ConsentDeniedReason, ProtocolError } from "./types";

/**
 * Every rejection from `UnivocalClient` is a `UnivocalError`.
 *
 * `code` is either a server error code (SPEC §10: `noSession`, `invalidOffset`,
 * `unknownRequest`, …), a {@link ConnectError} code for connection failures,
 * or a local code: `textTooLarge`, `invalidArgument`, `sessionEnded`,
 * `disconnected`, `notConnected`, `unsupported`.
 */
export class UnivocalError extends Error {
	readonly code: string;
	readonly fatal: boolean;
	readonly reason?: string;
	readonly sessionId?: string;
	readonly id?: string | number;

	constructor(
		code: string,
		message: string,
		extra: { fatal?: boolean; reason?: string; sessionId?: string; id?: string | number } = {},
	) {
		super(message);
		this.name = "UnivocalError";
		this.code = code;
		this.fatal = extra.fatal ?? false;
		if (extra.reason !== undefined) this.reason = extra.reason;
		if (extra.sessionId !== undefined) this.sessionId = extra.sessionId;
		if (extra.id !== undefined) this.id = extra.id;
	}

	/** Build from a server `error` frame. */
	static fromWire(msg: Record<string, unknown>): UnivocalError {
		const id = msg.id;
		return new UnivocalError(
			typeof msg.code === "string" ? msg.code : "internal",
			typeof msg.message === "string" ? msg.message : "Univocal reported an error.",
			{
				fatal: msg.fatal === true,
				reason: typeof msg.reason === "string" ? msg.reason : undefined,
				sessionId: typeof msg.sessionId === "string" ? msg.sessionId : undefined,
				id: typeof id === "string" || typeof id === "number" ? id : undefined,
			},
		);
	}

	toProtocolError(): ProtocolError {
		const out: ProtocolError = { code: this.code, message: this.message, fatal: this.fatal };
		if (this.id !== undefined) out.id = this.id;
		if (this.sessionId !== undefined) out.sessionId = this.sessionId;
		return out;
	}

	/** This error as the typed {@link ConnectError} union (for `ConnectionState.error`). */
	get connectError(): ConnectError {
		switch (this.code) {
			case "notInstalled":
			case "notRunning":
			case "unsupportedVersion":
				return { code: this.code };
			case "consentDenied":
				return { code: "consentDenied", reason: (this.reason ?? "user") as ConsentDeniedReason };
			case "unauthorized":
				return this.reason === undefined ? { code: "unauthorized" } : { code: "unauthorized", reason: this.reason };
			case "protocolError":
			case "timeout":
				return { code: this.code, message: this.message };
			default:
				return { code: "transport", message: this.message };
		}
	}
}

export function isUnivocalError(e: unknown): e is UnivocalError {
	return e instanceof UnivocalError;
}

/** Keep Error identity and metadata, and normalize unusual rejection values. */
export function asError(value: unknown): Error {
	if (value instanceof Error) return value;
	try { return new Error(String(value)); }
	catch { return new Error("Operation failed with an unreadable error."); }
}
