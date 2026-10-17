import { describe, expect, it } from "vitest";
import {
	ASKING_GLYPH,
	DEFAULT_APP_TITLE,
	WAITING_GLYPH,
	WORKING_GLYPH,
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
		expect(glyphFor("idle")).toBeUndefined();
	});

	it("holds working on a single steady mark", () => {
		expect(glyphFor("working")).toBe(WORKING_GLYPH);
	});

	it("never renders the app title while working", () => {
		expect(WORKING_GLYPH).not.toBe(DEFAULT_APP_TITLE);
	});

	it("holds waiting and asking on a single distinct mark", () => {
		expect(glyphFor("waiting")).toBe(WAITING_GLYPH);
		expect(glyphFor("asking")).toBe(ASKING_GLYPH);
	});

	it("keeps the three active states visually distinct", () => {
		expect(new Set([WORKING_GLYPH, WAITING_GLYPH, ASKING_GLYPH]).size).toBe(3);
	});
});

describe("cookingTitle", () => {
	it("matches pi's idle format exactly", () => {
		expect(
			cookingTitle(DEFAULT_APP_TITLE, "auth-refactor - proj", "idle")
		).toBe("π - auth-refactor - proj");
	});

	it("puts the working glyph in the app-title slot", () => {
		expect(cookingTitle("π", "auth-refactor - proj", "working")).toBe(
			`${WORKING_GLYPH} - auth-refactor - proj`
		);
	});

	it("shows the dedicated marks for waiting and asking", () => {
		expect(cookingTitle("π", "proj", "waiting")).toBe("◌ - proj");
		expect(cookingTitle("π", "proj", "asking")).toBe("⁇ - proj");
	});
});
