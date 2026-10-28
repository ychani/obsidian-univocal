import { type App, Notice, PluginSettingTab, requireApiVersion, Setting, type SettingDefinitionItem } from "obsidian";
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

	// Obsidian 1.12 uses this fallback; 1.13+ uses searchable definitions.
	override display(): void { this.renderLegacy(); }

	private refreshTab(): void {
		if (requireApiVersion("1.13.0")) this.update();
		else this.renderLegacy();
	}

	private showFailure(): void {
		new Notice("Univocal could not complete that action. Try again.");
	}

	override getControlValue(key: string): unknown {
		return Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key) ? this.host.settings[key as keyof UnivocalSettings] : undefined;
	}

	override async setControlValue(key: string, value: unknown): Promise<void> {
		if (!(Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key))) return;
		const settingKey = key as keyof UnivocalSettings;
		if (typeof value !== typeof DEFAULT_SETTINGS[settingKey]) return;
		Object.assign(this.host.settings, normalizeSettings({ ...this.host.settings, [key]: value }));
		await this.host.saveSettings();
		if (key === "rate") this.host.rateChanged();
		if (key === "highlightStyle") this.host.highlightStyleChanged();
		if (key === "connectDir") this.host.connectDirChanged();
		if (key === "developer") this.refreshTab();
	}

	override getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{ name: "Speaking rate", desc: "Sent to Univocal with each reading; changes apply to the current reading too.",
			  control: { type: "slider", key: "rate", min: RATE_MIN, max: RATE_MAX, step: 0.05 } },
			{ name: "Highlight style", desc: "How the spoken word is marked.",
			  control: { type: "dropdown", key: "highlightStyle", options: { background: "Background", underline: "Underline" } } },
			{ name: "Answer Univocal’s read hotkey", desc: "Read the focused note with highlighting when you press the read shortcut.",
			  control: { type: "toggle", key: "hotkeyRouting" } },
			{ type: "group", heading: "Authorization", items: [
				{ name: "Status", desc: authorizationSummary(this.host.readerState(), this.host.isConnected()),
				  render: (setting) => {
					const update = () => { setting.setDesc(authorizationSummary(this.host.readerState(), this.host.isConnected())); };
					update();
					this.unsubscribe?.();
					const off = this.host.onReaderChange(update);
					let live = true;
					const cleanup = () => {
						if (!live) return;
						live = false;
						off();
						if (this.unsubscribe === cleanup) this.unsubscribe = null;
					};
					this.unsubscribe = cleanup;
					return cleanup;
				  } },
				{ name: "Ask again", desc: "Ask Univocal to allow Obsidian. Univocal shows the prompt.",
				  action: () => { void this.host.askAgain().catch(() => this.showFailure()); } },
				{ name: "Forget authorization", desc: "Disconnect and remove the saved authorization. The next reading asks again.",
				  action: () => { void this.host.forgetAuthorization().catch(() => this.showFailure()); } },
			] },
			{ name: "Univocal for macOS", desc: "Requires the Univocal app. Note text stays on this Mac.",
			  render: (setting) => {
				setting.descEl.appendText(" ");
				setting.descEl.createEl("a", { text: "Get Univocal", href: UNIVOCAL_URL });
			  } },
			{ type: "group", heading: "Developer", items: [
				{ name: "Developer mode", desc: "Enable development commands and a connection directory override.",
				  control: { type: "toggle", key: "developer" } },
				{ name: "Connect directory", desc: "Leave empty to use Univocal’s default connection directory.",
				  visible: () => this.host.settings.developer,
				  control: { type: "text", key: "connectDir", placeholder: "~/Library/Application Support/Univocal/Connect" } },
			] },
		];
	}

	private renderLegacy(): void {
		const { containerEl } = this;
		containerEl.empty();
		this.unsubscribe?.();
		this.unsubscribe = null;
		const settings = this.host.settings;

		new Setting(containerEl)
			.setName("Speaking rate")
			.setDesc("Sent to Univocal with each reading; changes apply to the current reading too.")
			.addSlider((slider) => {
				slider.sliderEl.title = `${settings.rate}×`;
				slider
					.setLimits(RATE_MIN, RATE_MAX, 0.05)
					.setValue(settings.rate)
					.onChange(async (value) => {
						settings.rate = value;
						slider.sliderEl.title = `${value}×`;
						await this.host.saveSettings();
						this.host.rateChanged();
					});
			});

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
			.setDesc("Enables developer read, status, pause and stop commands, and the connection directory override.")
			.addToggle((t) =>
				t.setValue(settings.developer).onChange(async (value) => {
					settings.developer = value;
					await this.host.saveSettings();
					this.refreshTab();
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
							this.connectDirTimer = window.setTimeout(() => {
								this.connectDirTimer = null;
								void this.host.saveSettings().then(() => this.host.connectDirChanged()).catch(() => this.showFailure());
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
			void this.host.saveSettings().then(() => this.host.connectDirChanged()).catch(() => this.showFailure());
		}
	}
}
