/**
 * pi-memory — the entry point pi discovers.
 *
 * The implementation lives in `extension.ts` so tests can build the extension
 * against a fake API without importing pi's runtime.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMemoryExtension } from "./extension.ts";

export default function piMemory(pi: ExtensionAPI): void {
	createMemoryExtension(pi);
}
