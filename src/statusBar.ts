/**
 * Status bar item (plan §5). `statusBarModel` is pure (tested); `StatusBar`
 * renders it into the element from `addStatusBarItem()`.
 *
 * There are no transport controls here: Univocal's floating pill is the only
 * in-session reading control (and Univocal's ⌥⇧R toggles pause/resume).
 * While a reading is loading, playing or paused the item is a passive
 * indicator with no click action.
 */
import type { ReaderState } from "./controller";

export type StatusAction = "read" | "cancel" | "getUnivocal" | "launchUnivocal" | "openSettings";

export interface StatusButton {
	label: string;
	title: string;
	/** Absent: a passive indicator (not clickable). */
	action?: StatusAction;
}

export interface StatusModel {
	/** Hidden while idle and connected/available — nothing to say. */
	visible: boolean;
	buttons: StatusButton[];
}

const CONTROLS_HINT = "Use Univocal's floating controls to pause, skip or stop (⌥⇧R pauses/resumes)";

export function statusBarModel(state: ReaderState): StatusModel {
	switch (state.kind) {
		case "idle":
			return { visible: false, buttons: [] };
		case "notInstalled":
			return { visible: true, buttons: [{ label: "Get Univocal", title: "Read aloud needs the Univocal app", action: "getUnivocal" }] };
		case "notRunning":
			return { visible: true, buttons: [{ label: "Univocal off", title: "Start Univocal in the background", action: "launchUnivocal" }] };
		case "connecting":
			return {
				visible: true,
				buttons: [
					{ label: state.detail ?? "Connecting to Univocal…", title: "Connecting to Univocal. Click to cancel.", action: "cancel" },
				],
			};
		case "consentPending":
			return {
				visible: true,
				buttons: [{ label: "Waiting for approval in Univocal…", title: "Allow Obsidian in Univocal's prompt. Click to cancel.", action: "cancel" }],
			};
		case "denied":
			return { visible: true, buttons: [{ label: "Not allowed", title: `${state.message} Open settings.`, action: "openSettings" }] };
		case "loading":
			return { visible: true, buttons: [{ label: state.detail ?? "Starting…", title: CONTROLS_HINT }] };
		case "playing":
			return { visible: true, buttons: [{ label: "Reading aloud…", title: CONTROLS_HINT }] };
		case "paused":
			return { visible: true, buttons: [{ label: "Reading paused", title: CONTROLS_HINT }] };
		case "failed":
			return { visible: true, buttons: [{ label: "Univocal ⚠", title: `${state.message}. Click to try again.`, action: "read" }] };
	}
}

export class StatusBar {
	constructor(
		private readonly el: HTMLElement,
		private readonly run: (action: StatusAction) => void,
	) {
		el.addClass("univocal-status");
	}

	render(state: ReaderState): void {
		const model = statusBarModel(state);
		this.el.empty();
		this.el.toggle(model.visible);
		for (const b of model.buttons) {
			const action = b.action;
			const span = this.el.createSpan({
				cls: action ? "univocal-status-button mod-clickable" : "univocal-status-indicator",
				text: b.label,
			});
			span.setAttr("aria-label", b.title);
			span.setAttr("data-tooltip-position", "top");
			if (!action) continue;
			span.addEventListener("click", (evt) => {
				evt.preventDefault();
				this.run(action);
			});
		}
	}
}
