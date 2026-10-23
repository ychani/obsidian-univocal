import { Plugin } from "obsidian";

/** Univocal Read Aloud. Minimal shell; commands, settings and the controller land in batch C. */
export default class UnivocalReadAloudPlugin extends Plugin {
	override async onload(): Promise<void> {
		// TODO(C): settings, UnivocalClient, commands, ribbon, status bar, quiet connect on layout ready.
	}

	override onunload(): void {
		// TODO(C): stop session, clear highlighters, disconnect.
	}
}
