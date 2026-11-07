import type { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { openExternalUrl } from "./open.ts";

describe("openExternalUrl", () => {
	it("never opens a real browser during tests", () => {
		expect(openExternalUrl("https://example.com")).toBe(false);
	});

	it("does not crash the process when the opener emits an async error", async () => {
		const spawned: string[] = [];
		const fakeSpawn = ((command: string) => {
			spawned.push(command);
			const child = {
				on(event: string, handler: (error: unknown) => void) {
					if (event === "error") setTimeout(() => handler(new Error("spawn ENOENT")), 0);
					return child;
				},
				unref() {},
			};
			return child;
		}) as unknown as typeof spawn;

		expect(() => openExternalUrl("https://example.com", { spawn: fakeSpawn })).not.toThrow();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(spawned).toHaveLength(1);
	});
});
