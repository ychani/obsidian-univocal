import { describe, expect, it, vi } from "vitest";
import { parseWake, wakeProtocolHandler } from "../src/wakeProtocol";

describe("parseWake", () => {
	it("accepts a v1 wake with a request id", () => {
		expect(parseWake({ action: "univocal-connect", requestId: "h1", v: "1" })).toBe("h1");
	});
	it.each([
		[{ requestId: "h1" }],
		[{ requestId: "h1", v: "2" }],
		[{ v: "1" }],
		[{ requestId: "", v: "1" }],
		[{ requestId: "a b", v: "1" }],
		[{ requestId: "x".repeat(65), v: "1" }],
	])("rejects %j", (params) => {
		expect(parseWake(params as Record<string, string>)).toBeNull();
	});
});

describe("wakeProtocolHandler", () => {
	it("wakes with the request id and ignores invalid URLs", () => {
		const wake = vi.fn();
		const h = wakeProtocolHandler({ wake });
		h({ action: "univocal-connect", requestId: "r9", v: "1" } as never);
		h({ action: "univocal-connect", v: "1" } as never);
		expect(wake.mock.calls).toEqual([["r9"]]);
	});
});
