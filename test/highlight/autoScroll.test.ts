import { afterEach, describe, expect, it, vi } from "vitest";
import { createAutoScroller, editorPosRect } from "../../src/highlight/autoScroll";

function scroller(height = 1000) {
	const el = document.createElement("div");
	document.body.appendChild(el);
	Object.defineProperty(el, "clientHeight", { value: height, configurable: true });
	el.getBoundingClientRect = () => new DOMRect(0, 100, 600, height);
	el.scrollTop = 0;
	const scrollTo = vi.fn((opts: ScrollToOptions) => {
		el.scrollTop = opts.top ?? 0;
	});
	el.scrollTo = scrollTo as unknown as typeof el.scrollTo;
	return { el, scrollTo };
}

describe("auto-scroll", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("leaves a word inside the 25–75 % band alone and brings an outside one to 40 %", () => {
		let t = 0;
		const { el, scrollTo } = scroller();
		const s = createAutoScroller(el, { now: () => t, smooth: false });
		expect(s.follow({ top: 100 + 500, height: 20 })).toBe(false);
		expect(scrollTo).not.toHaveBeenCalled();
		expect(s.follow({ top: 100 + 900, height: 20 })).toBe(true);
		expect(scrollTo).toHaveBeenLastCalledWith({ top: 910 - 400, behavior: "auto" });
		s.dispose();
	});

	it("pauses for 4 s after wheel or key input", () => {
		let t = 1000;
		const { el, scrollTo } = scroller();
		const s = createAutoScroller(el, { now: () => t, smooth: false });
		el.dispatchEvent(new Event("wheel"));
		expect(s.paused).toBe(true);
		expect(s.follow({ top: 100 + 950, height: 20 })).toBe(false);
		t += 3999;
		expect(s.follow({ top: 100 + 950, height: 20 })).toBe(false);
		t += 2;
		expect(s.follow({ top: 100 + 950, height: 20 })).toBe(true);
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown" }));
		expect(s.paused).toBe(true);
		t += 4001;
		expect(s.paused).toBe(false);
		expect(scrollTo).toHaveBeenCalledTimes(1);
		s.dispose();
	});

	it("its own scroll does not pause it; a foreign scroll does", () => {
		let t = 0;
		const { el } = scroller();
		const s = createAutoScroller(el, { now: () => t, smooth: false });
		expect(s.follow({ top: 100 + 950, height: 20 })).toBe(true);
		t += 100;
		el.dispatchEvent(new Event("scroll"));
		expect(s.paused).toBe(false);
		t += 2000;
		el.dispatchEvent(new Event("scroll"));
		expect(s.paused).toBe(true);
		s.resume();
		expect(s.paused).toBe(false);
		s.dispose();
	});

	it("after dispose nothing follows and listeners are gone", () => {
		let t = 0;
		const { el, scrollTo } = scroller();
		const s = createAutoScroller(el, { now: () => t });
		s.dispose();
		el.dispatchEvent(new Event("wheel"));
		expect(s.paused).toBe(false);
		expect(s.follow({ top: 2000, height: 20 })).toBe(false);
		expect(scrollTo).not.toHaveBeenCalled();
	});

	it("measures Ranges without Range geometry via their parent element, and editor positions", () => {
		const { el, scrollTo } = scroller();
		const p = document.createElement("p");
		p.textContent = "word";
		el.appendChild(p);
		p.getBoundingClientRect = () => new DOMRect(0, 100 + 980, 100, 20);
		const r = document.createRange();
		r.selectNodeContents(p.firstChild!);
		const s = createAutoScroller(el, { smooth: false });
		expect(s.follow(r)).toBe(true);
		expect(scrollTo).toHaveBeenCalledWith({ top: 990 - 400, behavior: "auto" });
		expect(editorPosRect({ coordsAtPos: () => ({ top: 10, bottom: 30 }) }, 3)).toEqual({ top: 10, height: 20 });
		expect(editorPosRect({ coordsAtPos: () => null }, 3)).toBeNull();
		s.dispose();
	});
});
