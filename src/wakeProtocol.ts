/**
 * Wake URL handler (SPEC §16.5): `obsidian://univocal-connect?requestId=…&v=1`.
 *
 * Univocal opens it when Obsidian is running but the plugin isn't connected:
 * from Settings → Connections → Connect, or when ⌥⇧R is pressed in Obsidian.
 * The plugin answers by connecting with `hello{wakeRequestId}`. It must not
 * open a note, change the selection or focus anything.
 *
 * Imports only types from `obsidian`, so the parser is unit-testable.
 */
import type { ObsidianProtocolData } from "obsidian";

export const WAKE_PROTOCOL_ACTION = "univocal-connect";

/** Server-made ids are short tokens; anything else is not ours. */
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * Returns the request id, or null when the URL isn't a valid v1 wake.
 * `action` is Obsidian's own key (always "univocal-connect"), so the URL
 * carries no action of its own.
 */
export function parseWake(params: Record<string, string | undefined>): string | null {
	if (params.v !== "1") return null;
	const id = params.requestId;
	if (!id || !REQUEST_ID.test(id)) return null;
	return id;
}

export function wakeProtocolHandler(deps: {
	wake(requestId: string): void;
	log?(message: string): void;
}): (params: ObsidianProtocolData) => void {
	return (params) => {
		const id = parseWake(params as Record<string, string | undefined>);
		if (id === null) {
			deps.log?.("[univocal] ignoring an invalid univocal-connect URL");
			return;
		}
		deps.wake(id);
	};
}
