/**
 * Developer URL handler (plan §6): `obsidian://univocal-dev?cmd=read|stop|pause|status`.
 * Registered at load but inert unless the `developer` setting is on.
 *
 * - `cmd=read[&prefer=selection|document]` reads the active note.
 * - `cmd=pause` pauses / resumes.
 * - `cmd=stop` stops.
 * - `cmd=status[&tag=…]` writes `univocal-dev-status.json` into the connect
 *   dir: state, sessionId, last word/sentence range, painted-range counts and
 *   mode (for QA assertions). Never contains note text.
 *
 * Imports only types from `obsidian`, so the parser is unit-testable.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { ObsidianProtocolData } from "obsidian";
import type { DevStatus, StartPreference } from "./controller";

export const DEV_PROTOCOL_ACTION = "univocal-dev";
export const DEV_STATUS_FILE = "univocal-dev-status.json";

export type DevCommand =
	| { cmd: "read"; prefer?: StartPreference }
	| { cmd: "stop" }
	| { cmd: "pause" }
	| { cmd: "status"; tag?: string };

export function parseDevCommand(params: Record<string, string | undefined>): DevCommand | null {
	switch (params.cmd) {
		case "read": {
			const prefer = params.prefer;
			return prefer === "selection" || prefer === "document" ? { cmd: "read", prefer } : { cmd: "read" };
		}
		case "stop":
			return { cmd: "stop" };
		case "pause":
			return { cmd: "pause" };
		case "status":
			return params.tag ? { cmd: "status", tag: params.tag.slice(0, 64) } : { cmd: "status" };
		default:
			return null;
	}
}

export interface DevProtocolDeps {
	isEnabled(): boolean;
	/** Effective connect dir (setting → env → default). */
	connectDir(): string;
	read(prefer?: StartPreference): void;
	pauseResume(): void;
	stop(): void;
	status(): DevStatus;
	log?(message: string): void;
}

/** Write the status atomically (tmp + rename) so a polling test never reads half a file. */
export async function writeDevStatus(dir: string, payload: unknown): Promise<string> {
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, DEV_STATUS_FILE);
	const tmp = `${file}.${process.pid}.tmp`;
	await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
	await fs.rename(tmp, file);
	return file;
}

/** Runs one parsed command. Returns the status file path for `status`. */
export async function runDevCommand(command: DevCommand, deps: DevProtocolDeps): Promise<string | null> {
	switch (command.cmd) {
		case "read":
			deps.read(command.prefer);
			return null;
		case "pause":
			deps.pauseResume();
			return null;
		case "stop":
			deps.stop();
			return null;
		case "status": {
			const payload = command.tag ? { ...deps.status(), tag: command.tag } : deps.status();
			return writeDevStatus(deps.connectDir(), payload);
		}
	}
}

/** The handler to pass to `registerObsidianProtocolHandler(DEV_PROTOCOL_ACTION, …)`. */
export function devProtocolHandler(deps: DevProtocolDeps): (params: ObsidianProtocolData) => void {
	return (params) => {
		if (!deps.isEnabled()) return;
		const command = parseDevCommand(params);
		if (!command) {
			deps.log?.(`univocal-dev: unknown cmd ${String(params.cmd)}`);
			return;
		}
		runDevCommand(command, deps).catch((e) => deps.log?.(`univocal-dev: ${command.cmd} failed: ${String(e)}`));
	};
}
