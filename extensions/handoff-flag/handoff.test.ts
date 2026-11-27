import { describe, expect, it } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	HANDOFF_FILENAME,
	detectHandoff,
	formatAge,
	formatHandoffDetails,
	formatNoHandoff,
	handoffKey,
	renderHandoff,
	type FileStatLike,
	type HandoffFile,
} from "./handoff.ts";

const plainTheme = { fg: (_color: string, text: string) => text } as unknown as Theme;

const fileStat = (mtimeMs: number, size = 2048): FileStatLike => ({
	mtimeMs,
	size,
	isFile: () => true,
});

const handoff = (overrides: Partial<HandoffFile> = {}): HandoffFile => ({
	path: `/repo/${HANDOFF_FILENAME}`,
	ageMs: 0,
	sizeBytes: 2048,
	...overrides,
});

describe("detectHandoff", () => {
	it("reports the age and size of an existing handoff at the repository root", async () => {
		const found = await detectHandoff("/repo", async () => fileStat(1_000), 61_000);
		expect(found).toEqual({ path: `/repo/${HANDOFF_FILENAME}`, ageMs: 60_000, sizeBytes: 2048 });
	});

	it("looks for HANDOFF.md and nothing else", async () => {
		const asked: string[] = [];
		await detectHandoff("/repo", async (path) => {
			asked.push(path);
			throw new Error("ENOENT");
		}, 0);
		expect(asked).toEqual(["/repo/HANDOFF.md"]);
	});

	it("reads a missing file as no handoff", async () => {
		const missing = await detectHandoff("/repo", async () => {
			throw new Error("ENOENT");
		}, 0);
		expect(missing).toBeNull();
	});

	it("reads a directory named HANDOFF.md as no handoff", async () => {
		const directory = await detectHandoff(
			"/repo",
			async () => ({ mtimeMs: 0, size: 0, isFile: () => false }),
			0
		);
		expect(directory).toBeNull();
	});

	it("never reports a negative age when the clock and mtime disagree", async () => {
		const found = await detectHandoff("/repo", async () => fileStat(5_000), 1_000);
		expect(found?.ageMs).toBe(0);
	});
});

describe("formatAge", () => {
	it("buckets into minutes, hours, and days", () => {
		expect(formatAge(0)).toBe("<1m");
		expect(formatAge(59_999)).toBe("<1m");
		expect(formatAge(60_000)).toBe("1m");
		expect(formatAge(59 * 60_000)).toBe("59m");
		expect(formatAge(60 * 60_000)).toBe("1h");
		expect(formatAge(23 * 3_600_000)).toBe("23h");
		expect(formatAge(24 * 3_600_000)).toBe("1d");
		expect(formatAge(10 * 86_400_000)).toBe("10d");
	});
});

describe("renderHandoff", () => {
	it("renders a tick, the filename, and the age", () => {
		const line = renderHandoff(handoff({ ageMs: 3 * 3_600_000 }), plainTheme, 80);
		expect(line).toBe("✓ HANDOFF.md · 3h");
	});

	it("truncates to the terminal width", () => {
		const line = renderHandoff(handoff({ ageMs: 3 * 3_600_000 }), plainTheme, 8);
		expect(visibleWidth(line)).toBeLessThanOrEqual(8);
	});
});

describe("formatHandoffDetails", () => {
	it("names the age, size, path, and that it must be deleted", () => {
		const details = formatHandoffDetails(handoff({ ageMs: 2 * 86_400_000, sizeBytes: 5120 }));
		expect(details).toContain("HANDOFF.md — written 2d ago, 5.0 KB.");
		expect(details).toContain("/repo/HANDOFF.md");
		expect(details).toContain("rm HANDOFF.md");
	});

	it("says so plainly when there is none", () => {
		expect(formatNoHandoff("/repo")).toBe("No HANDOFF.md in /repo.");
	});
});

describe("handoffKey", () => {
	it("distinguishes absent from present", () => {
		expect(handoffKey(null)).toBe("absent");
		expect(handoffKey(handoff())).not.toBe("absent");
	});

	it("changes when the age bucket rolls over, so the poll repaints", () => {
		expect(handoffKey(handoff({ ageMs: 61_000 }))).not.toBe(handoffKey(handoff({ ageMs: 121_000 })));
		expect(handoffKey(handoff({ ageMs: 61_000 }))).toBe(handoffKey(handoff({ ageMs: 90_000 })));
	});

	it("changes when the file is rewritten inside the same bucket", () => {
		expect(handoffKey(handoff({ sizeBytes: 10 }))).not.toBe(handoffKey(handoff({ sizeBytes: 20 })));
	});
});
