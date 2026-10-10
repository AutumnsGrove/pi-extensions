import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	APPEARANCES,
	contrastFailures,
	generateAll,
	serialize,
	themePath,
} from "./generate.ts";
import { CONTRAST, FLAGS } from "./palettes.ts";

/** Required foreground roles from pi's theme schema. */
const REQUIRED_COLORS = [
	"accent",
	"border",
	"borderAccent",
	"borderMuted",
	"success",
	"error",
	"warning",
	"muted",
	"dim",
	"text",
	"thinkingText",
	"selectedBg",
	"userMessageBg",
	"userMessageText",
	"customMessageBg",
	"customMessageText",
	"customMessageLabel",
	"toolPendingBg",
	"toolSuccessBg",
	"toolErrorBg",
	"toolTitle",
	"toolOutput",
	"mdHeading",
	"mdLink",
	"mdLinkUrl",
	"mdCode",
	"mdCodeBlock",
	"mdCodeBlockBorder",
	"mdQuote",
	"mdQuoteBorder",
	"mdHr",
	"mdListBullet",
	"toolDiffAdded",
	"toolDiffRemoved",
	"toolDiffContext",
	"syntaxComment",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxVariable",
	"syntaxString",
	"syntaxNumber",
	"syntaxType",
	"syntaxOperator",
	"syntaxPunctuation",
	"thinkingOff",
	"thinkingMinimal",
	"thinkingLow",
	"thinkingMedium",
	"thinkingHigh",
	"thinkingXhigh",
	"bashMode",
] as const;

const themes = generateAll();

describe("pack shape", () => {
	it("covers every flag and appearance", () => {
		expect(themes).toHaveLength(FLAGS.length * APPEARANCES.length);
	});

	it("gives every theme a unique name with no slash", () => {
		const names = themes.map((theme) => theme.name);
		expect(new Set(names).size).toBe(names.length);
		for (const name of names) {
			expect(name).not.toContain("/");
			expect(name).not.toBe("system");
			expect(name.startsWith("pride")).toBe(true);
		}
	});

	it("uses the appearance-specific name suffix", () => {
		for (const theme of themes) {
			expect(theme.name.endsWith(`-${theme.appearance}`)).toBe(true);
		}
	});
});

describe("theme documents", () => {
	it("declares every required color as a six-digit hex value", () => {
		for (const theme of themes) {
			for (const role of REQUIRED_COLORS) {
				expect(theme.colors[role], `${theme.name}.${role}`).toMatch(
					/^#[0-9a-f]{6}$/
				);
			}
			expect(theme.export.pageBg).toMatch(/^#[0-9a-f]{6}$/);
			expect(theme.export.cardBg).toMatch(/^#[0-9a-f]{6}$/);
			expect(theme.export.infoBg).toMatch(/^#[0-9a-f]{6}$/);
		}
	});

	it("includes the optional thinking scrollbar and search roles", () => {
		for (const theme of themes) {
			for (const role of [
				"scrollbarTrack",
				"scrollbarThumb",
				"searchMatchBg",
				"searchMatchText",
				"thinkingMax",
			]) {
				expect(theme.colors[role], `${theme.name}.${role}`).toMatch(
					/^#[0-9a-f]{6}$/
				);
			}
		}
	});
});

describe("contrast", () => {
	it("keeps every foreground above its WCAG floor", () => {
		const failures = themes.flatMap(contrastFailures);
		expect(failures).toEqual([]);
	});

	it("holds body text to at least the AAA floor", () => {
		for (const theme of themes) {
			expect(CONTRAST.text).toBeGreaterThanOrEqual(7);
		}
	});
});

describe("committed files", () => {
	it.each(themes.map((theme) => [theme.name, theme] as const))(
		"matches themes/%s.json",
		(_name, theme) => {
			const onDisk = readFileSync(themePath(theme), "utf8");
			expect(onDisk).toBe(serialize(theme));
		}
	);
});
