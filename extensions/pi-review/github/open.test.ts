import { describe, expect, it } from "vitest";
import { openExternalUrl } from "./open.ts";

describe("openExternalUrl", () => {
	it("does not crash the process when the opener binary is missing", async () => {
		const original = process.env.PATH;
		process.env.PATH = "/nonexistent";
		const errors: unknown[] = [];
		const onError = (error: unknown) => errors.push(error);
		process.on("uncaughtException", onError);
		try {
			expect(() => openExternalUrl("https://example.com")).not.toThrow();
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(errors).toEqual([]);
		} finally {
			process.off("uncaughtException", onError);
			process.env.PATH = original;
		}
	});
});
