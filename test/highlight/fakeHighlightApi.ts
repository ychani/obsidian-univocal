/**
 * A faithful stand-in for the CSS Custom Highlight API, which jsdom lacks.
 * `Highlight` is set-like over AbstractRange (with `priority` and `type`);
 * `HighlightRegistry` is map-like and rejects non-Highlight values, like
 * Chromium does.
 */
export class FakeHighlight extends Set<AbstractRange> {
	priority = 0;
	type: "highlight" | "spelling-error" | "grammar-error" = "highlight";
	constructor(...ranges: AbstractRange[]) {
		super();
		for (const r of ranges) this.add(r);
	}
	override add(range: AbstractRange): this {
		if (!range || typeof (range as AbstractRange).startContainer === "undefined") {
			throw new TypeError("Failed to execute 'add' on 'Highlight': parameter 1 is not of type 'AbstractRange'.");
		}
		return super.add(range);
	}
}

export class FakeHighlightRegistry extends Map<string, FakeHighlight> {
	override set(name: string, highlight: FakeHighlight): this {
		if (!(highlight instanceof FakeHighlight)) {
			throw new TypeError("Failed to execute 'set' on 'HighlightRegistry': parameter 2 is not of type 'Highlight'.");
		}
		return super.set(name, highlight);
	}
}

interface Installable {
	Highlight?: unknown;
	CSS?: unknown;
}

/** Install on `win` (default: the jsdom window); returns the registry and an uninstaller. */
export function installFakeHighlightApi(win: Window = window): { registry: FakeHighlightRegistry; uninstall(): void } {
	const w = win as unknown as Installable;
	const prevHighlight = w.Highlight;
	const prevCSS = w.CSS;
	const registry = new FakeHighlightRegistry();
	const css = Object.create((prevCSS as object | undefined) ?? null) as Record<string, unknown>;
	css.highlights = registry;
	Object.defineProperty(win, "Highlight", { value: FakeHighlight, configurable: true, writable: true });
	Object.defineProperty(win, "CSS", { value: css, configurable: true, writable: true });
	return {
		registry,
		uninstall() {
			Object.defineProperty(win, "Highlight", { value: prevHighlight, configurable: true, writable: true });
			Object.defineProperty(win, "CSS", { value: prevCSS, configurable: true, writable: true });
		},
	};
}
