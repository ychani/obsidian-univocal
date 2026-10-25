import { execFile } from "node:child_process";
import { type Stats, unwatchFile, watchFile } from "node:fs";
import * as path from "node:path";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { type App, MarkdownView, Notice, Plugin, type TFile } from "obsidian";
import { type Logger, type TokenStore, UnivocalClient, createDefaultTokenStore, resolveConnectDir } from "./connect/index";
import { univocalFactories } from "./highlight/factories";
import {
	type NoteChange,
	type NoteHost,
	type NoteRef,
	type PaintedCount,
	ReadAloudController,
	type Surface,
	type SurfaceMode,
	createMappedSurface,
} from "./controller";
import { DEV_PROTOCOL_ACTION, devProtocolHandler } from "./devProtocol";
import { WAKE_PROTOCOL_ACTION, wakeProtocolHandler } from "./wakeProtocol";
import type { EditorHighlighterFactory, ReadingViewHighlighterFactory } from "./highlight/types";
import { UNIVOCAL_URL, UnivocalSettingTab, type UnivocalSettings, normalizeSettings } from "./settings";
import { StatusBar, type StatusAction } from "./statusBar";
import type { EditorTextMapFactory, ReadingViewTextMapFactory } from "./textmap/types";

// ---------------------------------------------------------------------------
// INTEGRATION SEAM — wire batch A (connect) and batch B (textmap/highlight).
// The stubs only declare factory *types*; replace each placeholder with the
// real implementation when the branches merge. Nothing else in the shell
// needs to change.
// ---------------------------------------------------------------------------

export interface ShellFactories {
	/** A: Keychain-backed token store (fallback 0600 file outside the vault). */
	tokenStore(logger: Logger): TokenStore;
	/** B: reading-view text map over `.markdown-preview-sizer`. */
	readingTextMap: ReadingViewTextMapFactory;
	/** B: CSS Custom Highlight API highlighter on the view's ownerDocument. */
	readingHighlighter: ReadingViewHighlighterFactory;
	/** B: CM6 text map (`text = editor.getValue()`). */
	editorTextMap: EditorTextMapFactory;
	/** B: CM6 decoration highlighter. */
	editorHighlighter: EditorHighlighterFactory;
	/** B: editor extensions the highlighter needs registered up front (e.g. its StateField), if any. */
	editorExtensions?: Extension[];
}

const FACTORIES: ShellFactories = {
	tokenStore: (logger) =>
		createDefaultTokenStore({
			onPrimaryError: (op, e) => logger.warn(`Keychain ${op} failed; using the file fallback`, e),
		}),
	...univocalFactories,
};

/**
 * Optional on B's highlighters: the real painted-range count, reported in the
 * dev status file. Reading view counts `CSS.highlights` directly instead.
 */
interface PaintedRangeCounter {
	paintedRangeCount(): PaintedCount;
}

// ---------------------------------------------------------------------------

export const CLIENT_ID = "md.obsidian.plugin.univocal";
const UNIVOCAL_BUNDLE_ID = "com.univocal.app";
const WORD_HIGHLIGHT = "univocal-word";
const SENTENCE_HIGHLIGHT = "univocal-sentence";
const UNDERLINE_CLASS = "univocal-highlight-underline";

function modeOf(view: MarkdownView): SurfaceMode {
	if (view.getMode() === "preview") return "reading";
	const state = view.getState() as { source?: unknown };
	return state.source === true ? "source" : "live-preview";
}

/** The CM6 view behind Obsidian's `Editor` (undocumented `.cm`; the only place we touch it). */
function editorViewOf(view: MarkdownView): EditorView | null {
	const cm = (view.editor as unknown as { cm?: EditorView }).cm;
	return cm ?? null;
}

interface HighlightRegistry {
	get(name: string): { size: number } | undefined;
}

/** Dev status only: what is actually in the DOM, independent of the painters' own bookkeeping. */
export interface DomProbe {
	highlightApi: boolean;
	cssWordText: string[];
	cssSentenceRanges: number;
	cssSentenceText: string[];
	editorWordEls: string[];
	editorSentenceEls: number;
	markWordEls: number;
}

function probeDom(doc: Document, root: HTMLElement | null): DomProbe {
	const win = doc.defaultView as (Window & { CSS?: { highlights?: Map<string, Set<Range>> } }) | null;
	const reg = win?.CSS?.highlights;
	const word = reg?.get(WORD_HIGHLIGHT);
	const sentence = reg?.get(SENTENCE_HIGHLIGHT);
	const scope: ParentNode = root ?? doc;
	return {
		highlightApi: !!reg,
		cssWordText: word ? [...word].map((r) => r.toString()) : [],
		cssSentenceRanges: sentence?.size ?? 0,
		cssSentenceText: sentence ? [...sentence].map((r) => r.toString()) : [],
		editorWordEls: [...scope.querySelectorAll(".cm-content .univocal-word")].map((e) => e.textContent ?? ""),
		editorSentenceEls: scope.querySelectorAll(".cm-content .univocal-sentence").length,
		markWordEls: scope.querySelectorAll("mark.univocal-word").length,
	};
}

function countCssHighlights(doc: Document): PaintedCount {
	const win = doc.defaultView as (Window & { CSS?: { highlights?: HighlightRegistry } }) | null;
	const reg = win?.CSS?.highlights;
	return { word: reg?.get(WORD_HIGHLIGHT)?.size ?? 0, sentence: reg?.get(SENTENCE_HIGHLIGHT)?.size ?? 0 };
}

class ObsidianNoteRef implements NoteRef {
	readonly path: string;
	readonly title: string;
	readonly mode: SurfaceMode;

	constructor(
		private readonly app: App,
		private readonly factories: ShellFactories,
		private readonly view: MarkdownView,
		private readonly file: TFile,
	) {
		this.path = file.path;
		this.title = file.basename;
		this.mode = modeOf(view);
	}

	private bodyStart(textLength: number): number {
		const end = this.app.metadataCache.getFileCache(this.file)?.frontmatterPosition?.end.offset ?? 0;
		return Math.min(Math.max(0, end), textLength);
	}

	isEmpty(): boolean {
		const text = this.mode === "reading" ? this.view.getViewData() : this.view.editor.getValue();
		return !/\S/.test(text.slice(this.bodyStart(text.length)));
	}

	isAlive(): boolean {
		return this.view.file === this.file && this.view.leaf.view === this.view && this.view.containerEl.isConnected && modeOf(this.view) === this.mode;
	}

	createSurface(): Surface | null {
		return this.mode === "reading" ? this.readingSurface() : this.editorSurface();
	}

	private readingSurface(): Surface | null {
		const container = this.view.previewMode.containerEl;
		const root = container.querySelector<HTMLElement>(".markdown-preview-sizer") ?? container;
		const scroller = container.matches(".markdown-preview-view") ? container : (container.querySelector(".markdown-preview-view") ?? container);
		const doc = container.ownerDocument;
		const f = this.factories;
		const map = f.readingTextMap(root);
		return createMappedSurface<Range[]>({
			mode: this.mode,
			map,
			highlighter: () => f.readingHighlighter(doc),
			selectionOffset: () => map.offsetForSelection(doc.getSelection()),
			firstVisibleOffset: () => map.firstVisibleOffset(scroller),
			complete: () => map.complete,
			sizeOf: (ranges) => ranges.length,
			countPainted: (h) => (h ? countCssHighlights(doc) : { word: 0, sentence: 0 }),
		});
	}

	private editorSurface(): Surface | null {
		const cm = editorViewOf(this.view);
		if (!cm) return null;
		const f = this.factories;
		const map = f.editorTextMap(cm, { bodyStart: this.bodyStart(cm.state.doc.length) });
		return createMappedSurface({
			mode: this.mode,
			map,
			highlighter: () => f.editorHighlighter(cm),
			selectionOffset: () => map.offsetForSelection(cm),
			firstVisibleOffset: () => map.firstVisibleOffset(cm),
			countPainted: (h) => (h as Partial<PaintedRangeCounter> | null)?.paintedRangeCount?.() ?? null,
		});
	}

	onChange(listener: (change: NoteChange) => void): () => void {
		if (this.mode !== "reading") {
			const ref = this.app.workspace.on("editor-change", (_editor, info) => {
				if (info === this.view) listener("edited");
			});
			return () => this.app.workspace.offref(ref);
		}
		// Reading view: Obsidian re-renders sections (edits elsewhere, virtualisation).
		const container = this.view.previewMode.containerEl;
		const win = container.ownerDocument.defaultView ?? window;
		let timer: number | null = null;
		const observer = new MutationObserver(() => {
			if (timer !== null) win.clearTimeout(timer);
			timer = win.setTimeout(() => {
				timer = null;
				listener("rerendered");
			}, 150);
		});
		observer.observe(container, { childList: true, subtree: true, characterData: true });
		return () => {
			observer.disconnect();
			if (timer !== null) win.clearTimeout(timer);
		};
	}
}

class ObsidianNoteHost implements NoteHost {
	constructor(
		private readonly app: App,
		private readonly factories: ShellFactories,
	) {}

	activeNote(): NoteRef | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view?.file) return null;
		return new ObsidianNoteRef(this.app, this.factories, view, view.file);
	}

	windowHasFocus(): boolean {
		return activeDocument.hasFocus();
	}
}

/** Polls `<connectDir>/connect.json` (works before the dir exists) to notice Univocal start/quit. */
class DiscoveryWatcher {
	private file: string | null = null;
	private readonly onStat = (curr: Stats, prev: Stats): void => {
		if (curr.mtimeMs > 0 && curr.mtimeMs !== prev.mtimeMs) this.appeared();
		else if (curr.mtimeMs === 0 && prev.mtimeMs > 0) this.gone();
	};

	constructor(
		private readonly appeared: () => void,
		private readonly gone: () => void,
	) {}

	watch(dir: string): void {
		this.stop();
		this.file = path.join(dir, "connect.json");
		watchFile(this.file, { interval: 2000, persistent: false }, this.onStat);
	}

	stop(): void {
		if (this.file) unwatchFile(this.file, this.onStat);
		this.file = null;
	}
}

export default class UnivocalReadAloudPlugin extends Plugin {
	settings: UnivocalSettings = normalizeSettings(null);
	controller!: ReadAloudController;
	private client!: UnivocalClient;
	private statusBar!: StatusBar;
	private watcher: DiscoveryWatcher | null = null;
	private readonly factories: ShellFactories = FACTORIES;
	private readonly styledDocs = new Set<Document>();

	override async onload(): Promise<void> {
		this.settings = normalizeSettings(await this.loadData());
		const logger = this.makeLogger();
		const tokenStore = this.factories.tokenStore(logger);
		this.client = new UnivocalClient({
			connectDir: this.settings.connectDir || undefined,
			clientInfo: { id: CLIENT_ID, name: "Obsidian", version: this.manifest.version },
			capabilities: ["word-events", "sentence-events", "hotkey-target"],
			tokenStore,
			logger,
			appBundleId: UNIVOCAL_BUNDLE_ID,
		});
		this.controller = new ReadAloudController({
			client: this.client,
			host: new ObsidianNoteHost(this.app, this.factories),
			settings: () => this.settings,
			tokenStore,
			defaultServerBundleId: UNIVOCAL_BUNDLE_ID,
			notify: (message) => new Notice(message),
			log: (message) => logger.debug(message),
		});
		if (this.factories.editorExtensions) this.registerEditorExtension(this.factories.editorExtensions);

		this.addCommands();
		this.addRibbonIcon("audio-lines", "Read aloud with Univocal", () => this.controller.readAloud());

		this.statusBar = new StatusBar(this.addStatusBarItem(), (action) => this.runStatusAction(action));
		this.statusBar.render(this.controller.state);
		this.register(this.controller.onChange((state) => this.statusBar.render(state)));

		this.addSettingTab(
			new UnivocalSettingTab(this.app, this, {
				app: this.app,
				settings: this.settings,
				saveSettings: () => this.saveSettings(),
				readerState: () => this.controller.state,
				isConnected: () => this.client.state.kind === "connected",
				onReaderChange: (listener) => this.controller.onChange(listener),
				effectiveConnectDir: () => this.connectDir(),
				connectDirChanged: () => this.connectDirChanged(),
				rateChanged: () => this.controller.rateChanged(this.settings.rate),
				highlightStyleChanged: () => this.applyHighlightStyle(),
				askAgain: () => this.controller.authorize(),
				forgetAuthorization: () => this.controller.forgetAuthorization(),
			}),
		);

		this.registerObsidianProtocolHandler(
			DEV_PROTOCOL_ACTION,
			devProtocolHandler({
				isEnabled: () => this.settings.developer,
				connectDir: () => this.connectDir(),
				read: (prefer) => void this.controller.read(prefer ? { prefer } : {}),
				pauseResume: () => void this.controller.devPauseResume(),
				stop: () => this.controller.stop(),
				status: () => ({ ...this.controller.devStatus(), dom: this.domProbe() }),
				log: (message) => logger.warn(message),
			}),
		);

		this.registerObsidianProtocolHandler(
			WAKE_PROTOCOL_ACTION,
			wakeProtocolHandler({
				wake: (requestId) => void this.controller.wake(requestId),
				log: (message) => logger.warn(message),
			}),
		);

		// Clear highlights on workspace changes; stop when the note being read goes away.
		const changed = (): void => this.controller.workspaceChanged();
		this.registerEvent(this.app.workspace.on("active-leaf-change", changed));
		this.registerEvent(this.app.workspace.on("file-open", changed));
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				changed();
				this.applyHighlightStyle();
			}),
		);
		this.registerEvent(this.app.workspace.on("window-open", () => this.applyHighlightStyle()));

		this.app.workspace.onLayoutReady(() => {
			this.applyHighlightStyle();
			this.controller.start();
			this.watcher = new DiscoveryWatcher(
				() => void this.controller.serverAppeared(),
				() => this.controller.serverGone(),
			);
			this.watcher.watch(this.connectDir());
		});
	}

	override onunload(): void {
		this.watcher?.stop();
		this.watcher = null;
		this.controller?.dispose();
		for (const doc of this.styledDocs) doc.body.removeClass(UNDERLINE_CLASS);
		this.styledDocs.clear();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private connectDir(): string {
		return resolveConnectDir(this.settings.connectDir || undefined);
	}

	private domProbe(): DomProbe {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const root = view?.containerEl ?? null;
		return probeDom(root?.ownerDocument ?? document, root);
	}

	private connectDirChanged(): void {
		this.controller.connectDirChanged(this.settings.connectDir || undefined);
		this.watcher?.watch(this.connectDir());
	}

	private addCommands(): void {
		this.addCommand({
			id: "read-aloud",
			name: "Read aloud",
			checkCallback: (checking) => {
				if (!this.app.workspace.getActiveViewOfType(MarkdownView)) return false;
				// A no-op while reading: Univocal's pill is the in-session control.
				if (!checking) this.controller.readAloud();
				return true;
			},
		});
	}

	private runStatusAction(action: StatusAction): void {
		switch (action) {
			case "read":
				this.controller.readAloud();
				return;
			case "cancel":
				// Cancel a start that is connecting or awaiting approval.
				this.controller.stop();
				return;
			case "getUnivocal":
				window.open(UNIVOCAL_URL);
				return;
			case "launchUnivocal":
				// Background launch; the discovery watcher connects once connect.json appears.
				execFile("open", ["-g", "-b", UNIVOCAL_BUNDLE_ID, "--args", "--connect"], (err) => {
					if (err) new Notice("Couldn't start Univocal.");
				});
				return;
			case "openSettings": {
				const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
				setting?.open();
				setting?.openTabById(this.manifest.id);
			}
		}
	}

	/** Underline style: a body class (main window and popouts) that styles.css keys off. */
	private applyHighlightStyle(): void {
		const docs = new Set<Document>([document]);
		this.app.workspace.iterateAllLeaves((leaf) => {
			docs.add(leaf.view.containerEl.ownerDocument);
		});
		const underline = this.settings.highlightStyle === "underline";
		for (const doc of docs) {
			doc.body.toggleClass(UNDERLINE_CLASS, underline);
			this.styledDocs.add(doc);
		}
	}

	private makeLogger(): Logger {
		const prefix = "[univocal]";
		return {
			debug: (msg, ...args) => {
				if (this.settings.developer) console.debug(prefix, msg, ...args);
			},
			info: (msg, ...args) => {
				if (this.settings.developer) console.info(prefix, msg, ...args);
			},
			warn: (msg, ...args) => console.warn(prefix, msg, ...args),
			error: (msg, ...args) => console.error(prefix, msg, ...args),
		};
	}
}
