import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolveConnectDir } from "../src/connect/index";

describe("scaffold", () => {
	it("manifest id is univocal-read-aloud", () => {
		const manifest = JSON.parse(readFileSync("manifest.json", "utf8")) as { id: string; isDesktopOnly: boolean };
		expect(manifest.id).toBe("univocal-read-aloud");
		expect(manifest.isDesktopOnly).toBe(true);
	});

	it("connect dir override wins", () => {
		expect(resolveConnectDir("/tmp/uco-x")).toBe("/tmp/uco-x");
	});
});
