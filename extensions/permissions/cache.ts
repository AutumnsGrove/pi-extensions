/**
 * Session-scoped verdict cache.
 *
 * Only settled verdicts (`allow` / `deny`) are cached; an `ask` is a human
 * decision and must not be replayed. The key includes the working directory so
 * the same relative command in another project is judged fresh.
 */

import { createHash } from "node:crypto";
import { callKey } from "./rules.ts";
import type { Verdict } from "./types.ts";

export class VerdictCache {
	private readonly entries = new Map<string, Verdict>();

	constructor(private readonly enabled = true) {}

	key(tool: string, input: Record<string, unknown>, cwd: string): string {
		return createHash("sha256").update(callKey(tool, input, cwd)).digest("hex");
	}

	get(key: string): Verdict | undefined {
		if (!this.enabled) return undefined;
		const hit = this.entries.get(key);
		return hit ? { ...hit, cached: true } : undefined;
	}

	set(key: string, verdict: Verdict): void {
		if (!this.enabled) return;
		if (verdict.decision === "ask" || verdict.error) return;
		this.entries.set(key, { ...verdict });
	}

	clear(): void {
		this.entries.clear();
	}

	get size(): number {
		return this.entries.size;
	}
}
