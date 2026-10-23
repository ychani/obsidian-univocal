import { type App, PluginSettingTab, Setting } from "obsidian";
import type { ReaderState } from "./controller";

export type HighlightStyle = "background" | "underline";

/** Persisted in the plugin's `data.json` (per vault). Never holds the token. */
export interface UnivocalSettings {
	/** Developer override of Univocal's connect dir; empty = `UNIVOCAL_CONNECT_DIR`, then the default. */
	connectDir: string;
	/** Enables the `obsidian://univocal-dev` handler and shows developer settings. */
	developer: boolean;
	rate: number;
	/** Answer Univocal's read hotkey (⌥⇧R) from the focused note; off → decline `userDisabled`. */
	hotkeyRouting: boolean;
	highlightStyle: HighlightStyle;
}

export const DEFAULT_SETTINGS: UnivocalSettings = {
	connectDir: "",
	developer: false,
	rate: 1,
	hotkeyRouting: true,
	highlightStyle: "background",
};

export const RATE_MIN = 0.5;
export const RATE_MAX = 3;

export const UNIVOCAL_URL = "https://univocalapp.com";

/** Merge stored data over the defaults, dropping wrong-typed values. */
export function normalizeSettings(raw: unknown): UnivocalSettings {
	const s: UnivocalSettings = { ...DEFAULT_SETTINGS };
	if (!raw || typeof raw !== "object") return s;
	const r = raw as Record<string, unknown>;
	if (typeof r.connectDir === "string") s.connectDir = r.connectDir.trim();
	if (typeof r.developer === "boolean") s.developer = r.developer;
	if (typeof r.rate === "number" && Number.isFinite(r.rate)) s.rate = Math.min(RATE_MAX, Math.max(RATE_MIN, r.rate));
	if (typeof r.hotkeyRouting === "boolean") s.hotkeyRouting = r.hotkeyRouting;
	if (r.highlightStyle === "background" || r.highlightStyle === "underline") s.highlightStyle = r.highlightStyle;
	return s;
}

/** One line describing the authorization, for the settings tab. */
export function authorizationSummary(state: ReaderState, connected: boolean): string {
	if (connected) return "Allowed — connected to Univocal.";
	switch (state.kind) {
		case "notInstalled":
			return "Univocal isn't installed.";
		case "notRunning":
			return "Univocal isn't running. Obsidian connects when it starts, if you allowed it before.";
		case "connecting":
			return "Connecting to Univocal…";
		case "consentPending":
			return "Waiting for approval in Univocal…";
		case "denied":
			return `Not allowed. ${state.message}`;
		default:
			return "Not connected. Reading aloud asks Univocal for permission the first time.";
	}
}

/** What the settings tab needs from the plugin. */
export interface SettingsHost {
	app: App;
	settings: UnivocalSettings;
	saveSettings(): Promise<void>;
	readerState(): ReaderState;
	isConnected(): boolean;
	onReaderChange(listener: () => void): () => void;
	/** The effective connect dir (after env/default resolution), for display. */
	effectiveConnectDir(): string;
	connectDirChanged(): void;
	rateChanged(): void;
	highlightStyleChanged(): void;
	askAgain(): Promise<void>;
	forgetAuthorization(): Promise<void>;
}

export class UnivocalSettingTab extends PluginSettingTab {
	private unsubscribe: (() => void) | null = null;
	private connectDirTimer: number | null = null;

	constructor(
		app: App,
		plugin: ConstructorParameters<typeof PluginSettingTab>[1],
		private readonly host: SettingsHost,
	) {
		super(app, plugin);
	}

	override display(): void {
		const { containerEl } = this;
		containerEl.empty();
		this.unsubscribe?.();
		this.unsubscribe = null;
		const settings = this.host.settings;

		new Setting(containerEl)
			.setName("Speaking rate")
			.setDesc("Sent to Univocal with each reading; changes apply to the current reading too.")
			.addSlider((slider) =>
				slider
					.setLimits(RATE_MIN, RATE_MAX, 0.05)
					.setValue(settings.rate)
					.setDynamicTooltip()
					.onChange(async (value) => {
						settings.rate = value;
						await this.host.saveSettings();
						this.host.rateChanged();
					}),
			);

		new Setting(containerEl)
			.setName("Highlight style")
			.setDesc("How the word being spoken is marked. Use underline if your theme colours lines.")
			.addDropdown((dd) =>
				dd
					.addOption("background", "Background")
					.addOption("underline", "Underline")
					.setValue(settings.highlightStyle)
					.onChange(async (value) => {
						settings.highlightStyle = value === "underline" ? "underline" : "background";
						await this.host.saveSettings();
						this.host.highlightStyleChanged();
					}),
			);

		new Setting(containerEl)
			.setName("Answer Univocal's read hotkey")
			.setDesc(
				"When on, pressing Univocal's hotkey (⌥⇧R by default) while this vault is in front reads the focused note here, with highlighting. When off, Univocal reads the selection in its own panel.",
			)
			.addToggle((t) =>
				t.setValue(settings.hotkeyRouting).onChange(async (value) => {
					settings.hotkeyRouting = value;
					await this.host.saveSettings();
				}),
			);

		// --- Authorization ---
		new Setting(containerEl).setName("Authorization").setHeading();
		const status = new Setting(containerEl).setName("Status");
		const renderStatus = (): void => {
			status.setDesc(authorizationSummary(this.host.readerState(), this.host.isConnected()));
		};
		renderStatus();
		this.unsubscribe = this.host.onReaderChange(renderStatus);

		new Setting(containerEl)
			.setName("Ask again")
			.setDesc("Ask Univocal to allow Obsidian. Univocal shows the prompt.")
			.addButton((b) =>
				b.setButtonText("Ask again").onClick(async () => {
					await this.host.askAgain();
					renderStatus();
				}),
			);

		new Setting(containerEl)
			.setName("Forget authorization")
			.setDesc("Disconnect and delete the stored grant from the macOS Keychain. The next reading asks again.")
			.addButton((b) =>
				b
					.setButtonText("Forget")
					.setWarning()
					.onClick(async () => {
						await this.host.forgetAuthorization();
						renderStatus();
					}),
			);

		const about = containerEl.createDiv({ cls: "setting-item-description" });
		about.appendText("Reading aloud needs the ");
		about.createEl("a", { text: "Univocal", href: UNIVOCAL_URL });
		about.appendText(
			" app for macOS. Note text goes only to Univocal on this Mac; the grant is kept in the macOS Keychain, never in the vault.",
		);

		// --- Developer ---
		new Setting(containerEl).setName("Developer").setHeading();
		new Setting(containerEl)
			.setName("Developer mode")
			.setDesc("Enables the obsidian://univocal-dev URL handler (read, stop, pause, status) and the connect directory override.")
			.addToggle((t) =>
				t.setValue(settings.developer).onChange(async (value) => {
					settings.developer = value;
					await this.host.saveSettings();
					this.display();
				}),
			);

		if (settings.developer) {
			new Setting(containerEl)
				.setName("Connect directory")
				.setDesc(`Where Univocal's connect.json lives. Empty uses UNIVOCAL_CONNECT_DIR, then the default. Now: ${this.host.effectiveConnectDir()}`)
				.addText((text) =>
					text
						.setPlaceholder("~/Library/Application Support/Univocal/Connect")
						.setValue(settings.connectDir)
						.onChange((value) => {
							settings.connectDir = value.trim();
							if (this.connectDirTimer !== null) window.clearTimeout(this.connectDirTimer);
							this.connectDirTimer = window.setTimeout(async () => {
								this.connectDirTimer = null;
								await this.host.saveSettings();
								this.host.connectDirChanged();
							}, 600);
						}),
				);
		}
	}

	override hide(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
		if (this.connectDirTimer !== null) {
			window.clearTimeout(this.connectDirTimer);
			this.connectDirTimer = null;
			void this.host.saveSettings().then(() => this.host.connectDirChanged());
		}
	}
}
