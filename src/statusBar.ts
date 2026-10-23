/**
 * Status bar item (plan §5). `statusBarModel` is pure (tested); `StatusBar`
 * renders it into the element from `addStatusBarItem()`.
 */
import type { ReaderState } from "./controller";

export type StatusAction = "read" | "pauseResume" | "stop" | "getUnivocal" | "launchUnivocal" | "openSettings";

export interface StatusButton {
	label: string;
	title: string;
	action: StatusAction;
}

export interface StatusModel {
	/** Hidden while idle and connected/available — nothing to say. */
	visible: boolean;
	buttons: StatusButton[];
}

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
					{ label: state.detail ?? "Connecting to Univocal…", title: "Connecting to Univocal", action: "stop" },
				],
			};
		case "consentPending":
			return {
				visible: true,
				buttons: [{ label: "Waiting for approval in Univocal…", title: "Allow Obsidian in Univocal's prompt. Click to cancel.", action: "stop" }],
			};
		case "denied":
			return { visible: true, buttons: [{ label: "Not allowed", title: `${state.message} Open settings.`, action: "openSettings" }] };
		case "loading":
			return {
				visible: true,
				buttons: [
					{ label: "⏸", title: state.detail ?? "Starting…", action: "pauseResume" },
					{ label: "■", title: "Stop reading", action: "stop" },
				],
			};
		case "playing":
			return {
				visible: true,
				buttons: [
					{ label: "⏸", title: "Pause reading", action: "pauseResume" },
					{ label: "■", title: "Stop reading", action: "stop" },
				],
			};
		case "paused":
			return {
				visible: true,
				buttons: [
					{ label: "⏵", title: "Resume reading", action: "pauseResume" },
					{ label: "■", title: "Stop reading", action: "stop" },
				],
			};
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
			const span = this.el.createSpan({ cls: "univocal-status-button mod-clickable", text: b.label });
			span.setAttr("aria-label", b.title);
			span.setAttr("data-tooltip-position", "top");
			span.addEventListener("click", (evt) => {
				evt.preventDefault();
				this.run(b.action);
			});
		}
	}
}
