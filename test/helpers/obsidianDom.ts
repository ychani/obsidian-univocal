/** Minimal owner-window DOM helpers supplied by Obsidian in production. */
export function installObsidianDom(doc: Document): void {
    const win = doc.defaultView;
    if (!win) return;
    Object.defineProperty(doc, "win", { configurable: true, value: win });
    win.createEl = ((tag: keyof HTMLElementTagNameMap) => doc.createElement(tag)) as typeof createEl;
}
installObsidianDom(document);
