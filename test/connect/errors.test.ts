import { describe, expect, it } from "vitest";
import { asError, UnivocalError } from "../../src/connect/errors";
import { withTimeout } from "../../src/connect/tokenStore";

describe("rejection normalization", () => {
    it("preserves protocol and native Error identity and metadata", () => {
        const error = new UnivocalError("transport", "failed", { fatal: true });
        expect(asError(error)).toBe(error);
        expect(asError(error)).toMatchObject({ code: "transport", fatal: true });
    });
    it("still rejects with an Error when a rejection value cannot be stringified", async () => {
        const unreadable = { toString() { throw new Error("bad toString"); } };
        await expect(withTimeout(Promise.reject(unreadable), 100, "test")).rejects.toThrow("unreadable error");
    });
    it("normalizes string rejections at the token-store timeout boundary", async () => {
        await expect(withTimeout(Promise.reject("denied"), 100, "test")).rejects.toThrow("denied");
    });
});
