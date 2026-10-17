import { describe, expect, it } from "vitest";
import {
	ASKING_GLYPH,
	DEFAULT_APP_TITLE,
	WAITING_GLYPH,
	WORKING_FRAMES,
	cookingTitle,
	glyphFor,
	sessionDescriptor,
} from "./spinner.ts";

describe("sessionDescriptor", () => {
	it("joins the session name and cwd", () => {
		expect(sessionDescriptor("auth-refactor", "pi-extensions")).toBe(
			"auth-refactor - pi-extensions"
		);
	});

	it("drops the session part when there is no name", () => {
		expect(sessionDescriptor(undefined, "pi-extensions")).toBe(
			"pi-extensions"
		);
		expect(sessionDescriptor("   ", "pi-extensions")).toBe("pi-extensions");
	});

	it("trims a padded session name", () => {
		expect(sessionDescriptor("  fix bug  ", "proj")).toBe("fix bug - proj");
	});
});

describe("glyphFor", () => {
	it("returns nothing when idle so the caller can fall back to the app title", () => {
		expect(glyphFor("idle", 0)).toBeUndefined();
	});

	it("cycles the working frames one per tick", () => {
		const seen = WORKING_FRAMES.map((_, index) => glyphFor("working", index));
		expect(seen).toEqual([...WORKING_FRAMES]);
	});

	it("wraps the working cycle", () => {
		expect(glyphFor("working", WORKING_FRAMES.length)).toBe(
			WORKING_FRAMES[0]
		);
		expect(glyphFor("working", -1)).toBe(
			WORKING_FRAMES[WORKING_FRAMES.length - 1]
		);
	});

	it("never renders the app title as a working frame", () => {
		expect(WORKING_FRAMES).not.toContain(DEFAULT_APP_TITLE);
	});

	it("holds waiting and asking on a single distinct mark", () => {
		expect(glyphFor("waiting", 0)).toBe(WAITING_GLYPH);
		expect(glyphFor("waiting", 99)).toBe(WAITING_GLYPH);
		expect(glyphFor("asking", 0)).toBe(ASKING_GLYPH);
		expect(glyphFor("asking", 99)).toBe(ASKING_GLYPH);
	});

	it("keeps the three active states visually distinct", () => {
		expect(new Set([WORKING_FRAMES[0], WAITING_GLYPH, ASKING_GLYPH]).size).toBe(
			3
		);
	});
});

describe("cookingTitle", () => {
	it("matches pi's idle format exactly", () => {
		expect(
			cookingTitle(DEFAULT_APP_TITLE, "auth-refactor - proj", "idle", 0)
		).toBe("π - auth-refactor - proj");
	});

	it("puts the animated glyph in the app-title slot", () => {
		expect(cookingTitle("π", "auth-refactor - proj", "working", 0)).toBe(
			`${WORKING_FRAMES[0]} - auth-refactor - proj`
		);
	});

	it("shows the dedicated marks for waiting and asking", () => {
		expect(cookingTitle("π", "proj", "waiting", 5)).toBe("◌ - proj");
		expect(cookingTitle("π", "proj", "asking", 5)).toBe("⁇ - proj");
	});
});
