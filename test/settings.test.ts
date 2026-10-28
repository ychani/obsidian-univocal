import { describe, expect, it, vi } from "vitest";
import type { App, Plugin, SettingDefinition, SettingDefinitionGroup, SettingDefinitionItem, SettingDefinitionRender } from "obsidian";

vi.mock("obsidian", () => ({
    PluginSettingTab: class { update = vi.fn(); },
    Setting: class {},
    Notice: class {},
    requireApiVersion: () => true,
}));

import { DEFAULT_SETTINGS, UnivocalSettingTab, type SettingsHost } from "../src/settings";

function fixture() {
    const host: SettingsHost = {
        app: {} as App, settings: { ...DEFAULT_SETTINGS }, saveSettings: vi.fn(async () => {}),
        readerState: () => ({ kind: "idle" }), isConnected: () => false,
        onReaderChange: vi.fn(() => vi.fn()), effectiveConnectDir: () => "/tmp/test-connect",
        connectDirChanged: vi.fn(), rateChanged: vi.fn(), highlightStyleChanged: vi.fn(),
        askAgain: vi.fn(async () => {}), forgetAuthorization: vi.fn(async () => {}),
    };
    return { host, tab: new UnivocalSettingTab(host.app, {} as Plugin, host) };
}

function flatten(items: SettingDefinitionItem[]): SettingDefinition[] {
    return items.flatMap(item => "type" in item ? flatten((item as SettingDefinitionGroup).items ?? []) : [item]);
}

describe("searchable settings with legacy support", () => {
    it("registers every preference for modern settings search without writing or connecting", () => {
        const { host, tab } = fixture();
        const controls = flatten(tab.getSettingDefinitions()).flatMap(item => item.control ? [item.control.key] : []);
        expect(controls.sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
        expect(host.saveSettings).not.toHaveBeenCalled();
        expect(host.askAgain).not.toHaveBeenCalled();
        expect(host.forgetAuthorization).not.toHaveBeenCalled();
        expect(typeof tab.display).toBe("function");
    });

    it("persists normalized values and applies playback/connection side effects", async () => {
        const { host, tab } = fixture();
        await tab.setControlValue("rate", 20);
        expect(host.settings.rate).toBe(3);
        expect(host.rateChanged).toHaveBeenCalledOnce();
        await tab.setControlValue("highlightStyle", "underline");
        expect(host.highlightStyleChanged).toHaveBeenCalledOnce();
        await tab.setControlValue("connectDir", "  /tmp/other  ");
        expect(host.settings.connectDir).toBe("/tmp/other");
        expect(host.connectDirChanged).toHaveBeenCalledOnce();
        await tab.setControlValue("developer", true);
        expect(tab.update).toHaveBeenCalledOnce();
    });

    it("ignores unknown/prototype keys and wrong-typed values", async () => {
        const { host, tab } = fixture();
        for (const key of ["constructor", "__proto__", "unknown"]) await tab.setControlValue(key, "value");
        await tab.setControlValue("rate", "wrong type");
        expect(host.saveSettings).not.toHaveBeenCalled();
        expect(tab.getControlValue("constructor")).toBeUndefined();
        expect(host.settings).toEqual(DEFAULT_SETTINGS);
    });

    it("keeps authorization status live and releases its listener exactly once", () => {
        const { host, tab } = fixture();
        const status = flatten(tab.getSettingDefinitions()).find(item => item.name === "Status") as SettingDefinitionRender;
        const setDesc = vi.fn();
        const cleanup = status.render({ setDesc } as never, {} as never);
        expect(setDesc).toHaveBeenCalledWith("Not connected. Reading aloud asks Univocal for permission the first time.");
        const update = vi.mocked(host.onReaderChange).mock.calls[0]![0];
        host.isConnected = () => true;
        update();
        expect(setDesc).toHaveBeenLastCalledWith("Allowed — connected to Univocal.");
        tab.hide();
        if (typeof cleanup === "function") cleanup();
        expect(vi.mocked(host.onReaderChange).mock.results[0]!.value).toHaveBeenCalledOnce();
    });
});
