import type { Logger, Unsubscribe } from "./types";

/** Minimal typed emitter; a throwing listener is logged and never breaks the others. */
export class Emitter<E> {
	private listeners = new Map<keyof E, Set<(payload: never) => void>>();

	constructor(private readonly logger?: Logger) {}

	on<K extends keyof E>(event: K, listener: (payload: E[K]) => void): Unsubscribe {
		let set = this.listeners.get(event);
		if (!set) {
			set = new Set();
			this.listeners.set(event, set);
		}
		const l = listener as (payload: never) => void;
		set.add(l);
		return () => {
			set.delete(l);
		};
	}

	emit<K extends keyof E>(event: K, payload: E[K]): void {
		const set = this.listeners.get(event);
		if (!set) return;
		for (const l of [...set]) {
			try {
				(l as (p: E[K]) => void)(payload);
			} catch (e) {
				this.logger?.error(`[univocal] listener for "${String(event)}" threw`, e);
			}
		}
	}

	clear(): void {
		this.listeners.clear();
	}
}

export const noopLogger: Logger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
};

/** Node timers keep a process alive; the plugin and tests must not. No-op for DOM timers. */
export function unref<T>(t: T): T {
	(t as { unref?: () => void } | null)?.unref?.();
	return t;
}
