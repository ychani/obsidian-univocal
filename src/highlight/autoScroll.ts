/**
 * Scroll-follow: keep the spoken word inside a comfort band (25 %–75 % of
 * the scroller's height), bringing it to 40 % when it leaves. Any user wheel,
 * touch, key input, or a scroll we did not start pauses following for 4 s.
 */
import { followScrollTop } from "../textmap/core";

export interface AutoScrollerOptions {
	/** Pause after user input, ms. Default 4000. */
	pauseMs?: number;
	/** Clock (tests). Default `Date.now`. */
	now?: () => number;
	/** Smooth scrolling; default honours `prefers-reduced-motion`. */
	smooth?: boolean;
	/**
	 * Where key input is listened for. Default: the scroller's document (so
	 * PageDown in a focused reading view counts).
	 */
	keyTarget?: EventTarget;
}

export interface RectLike {
	top: number;
	height: number;
}

export type FollowTarget = Range | Element | RectLike;

export interface AutoScroller {
	/** Scroll so `target` (client coordinates) is in the comfort band. Returns whether it scrolled. */
	follow(target: FollowTarget | null | undefined): boolean;
	/** True while following is paused by user input. */
	readonly paused: boolean;
	/** Pause now (e.g. the user clicked to seek). */
	pause(): void;
	/** Resume following immediately. */
	resume(): void;
	dispose(): void;
}

function rectOf(target: FollowTarget): RectLike | null {
	if (typeof (target as Range | Element).getBoundingClientRect === "function") {
		const r = (target as Range | Element).getBoundingClientRect();
		if (!r || (r.width === 0 && r.height === 0)) return null;
		return { top: r.top, height: r.height };
	}
	if ("top" in target && typeof target.top === "number") return target;
	// A Range in an engine without Range geometry: measure its start's parent.
	const start = (target as Range).startContainer;
	const el = start && (start.nodeType === 1 ? (start as Element) : start.parentElement);
	if (!el) return null;
	const r = el.getBoundingClientRect();
	return r.width === 0 && r.height === 0 ? null : { top: r.top, height: r.height };
}

const SCROLL_SETTLE_MS = 150;
const PROGRAMMATIC_SCROLL_MS = 800;

export function createAutoScroller(scroller: HTMLElement, options: AutoScrollerOptions = {}): AutoScroller {
	const pauseMs = options.pauseMs ?? 4000;
	const now = options.now ?? Date.now;
	const doc = scroller.ownerDocument;
	const win = doc.defaultView;
	const keyTarget = options.keyTarget ?? doc;
	let pausedUntil = 0;
	let programmaticUntil = 0;
	let disposed = false;

	const userInput = () => {
		pausedUntil = now() + pauseMs;
	};
	const onScroll = () => {
		const t = now();
		if (t < programmaticUntil) {
			// Our smooth scroll is still moving.
			programmaticUntil = Math.max(programmaticUntil, t + SCROLL_SETTLE_MS);
			return;
		}
		userInput();
	};
	const passive = { passive: true, capture: true } as const;
	scroller.addEventListener("wheel", userInput, passive);
	scroller.addEventListener("touchmove", userInput, passive);
	scroller.addEventListener("scroll", onScroll, { passive: true });
	keyTarget.addEventListener("keydown", userInput, true);

	const smooth = () => {
		if (options.smooth !== undefined) return options.smooth;
		try {
			return !win?.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
		} catch {
			return true;
		}
	};

	return {
		get paused() {
			return now() < pausedUntil;
		},
		pause() {
			userInput();
		},
		resume() {
			pausedUntil = 0;
		},
		follow(target) {
			if (disposed || !target || now() < pausedUntil) return false;
			const rect = rectOf(target);
			if (!rect) return false;
			const view = scroller.getBoundingClientRect();
			const height = scroller.clientHeight || view.height;
			if (!(height > 0)) return false;
			const top = followScrollTop(rect.top - view.top, rect.height, scroller.scrollTop, height);
			if (top === null || top === scroller.scrollTop) return false;
			programmaticUntil = now() + PROGRAMMATIC_SCROLL_MS;
			if (typeof scroller.scrollTo === "function") scroller.scrollTo({ top, behavior: smooth() ? "smooth" : "auto" });
			else scroller.scrollTop = top;
			return true;
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			scroller.removeEventListener("wheel", userInput, passive);
			scroller.removeEventListener("touchmove", userInput, passive);
			scroller.removeEventListener("scroll", onScroll, { passive: true } as EventListenerOptions);
			keyTarget.removeEventListener("keydown", userInput, true);
		},
	};
}

/** Client rect of an editor position, for `follow()` (`null` when off-viewport/unmeasured). */
export function editorPosRect(view: { coordsAtPos(pos: number): { top: number; bottom: number } | null }, pos: number): RectLike | null {
	const c = view.coordsAtPos(pos);
	return c ? { top: c.top, height: c.bottom - c.top } : null;
}
