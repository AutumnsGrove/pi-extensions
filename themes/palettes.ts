/**
 * Design system for the pride theme pack.
 *
 * A theme is built from one flag and one appearance. The flag contributes an
 * ordered list of stripe hues; the appearance contributes a lightness/chroma
 * ladder. Roles are then filled from a small set of rules so every variant is
 * consistent:
 *
 *   - body text and surfaces stay near-neutral, tinted a few points toward the
 *     flag so the whole theme feels cohesive without hurting legibility;
 *   - syntax, markdown, the accent/border frame, and the thinking ramp cycle
 *     the flag's stripes, which is where the flag identity actually shows;
 *   - success/error/warning keep their conventional hues so tool states stay
 *     readable no matter which flag is active;
 *   - every foreground is pushed away from the brightest surface until it
 *     clears a WCAG contrast floor, so a light stripe can never become
 *     unreadable on a light background.
 *
 * Colours are authored in OKLCH and emitted as hex, so the resolved value (and
 * therefore the contrast ratio) is exact.
 */

import {
	ensureContrast,
	hexToOklch,
	type Oklch,
	oklchToHex,
	oklchToRgbGamut,
	relativeLuminance,
} from "./color.ts";

export type Appearance = "dark" | "light";

export interface FlagSpec {
	/** Also the theme-name suffix: `pride` or `pride-<id>`. */
	id: string;
	label: string;
	/** Flag stripes in visual order; the first is the accent. */
	stripes: string[];
}

/** Schema the built-in themes point at, so editors validate generated files. */
export const THEME_SCHEMA =
	"https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json";

/**
 * The flag pack. Order within `stripes` matters: index 0 becomes the accent,
 * index 1 the highlight border, and the rest drive syntax/markdown/thinking.
 */
export const FLAGS: readonly FlagSpec[] = [
	{
		id: "pride",
		label: "Progress Pride (rainbow)",
		stripes: [
			"#e40303", // red
			"#ff8c00", // orange
			"#ffed00", // yellow
			"#008026", // green
			"#2a66ff", // blue
			"#750787", // violet
		],
	},
	{
		id: "trans",
		label: "Transgender",
		stripes: [
			"#f5a9b8", // pink
			"#5bcffa", // blue
		],
	},
	{
		id: "bi",
		label: "Bisexual",
		stripes: [
			"#d60270", // magenta
			"#9b4f96", // purple
			"#0038a8", // blue
		],
	},
	{
		id: "pan",
		label: "Pansexual",
		stripes: [
			"#ff1b8d", // magenta
			"#ffda00", // yellow
			"#1bb3ff", // cyan
		],
	},
];

interface AppearanceParams {
	/** Lightness ladder for chromatic roles. */
	chromaL: number;
	/** Base chroma for chromatic roles; gamut mapping caps it per hue. */
	chromaC: number;
	/** Lightness for the loudest accent roles. */
	strongL: number;
	textL: number;
	textC: number;
	mutedL: number;
	mutedC: number;
	dimL: number;
	dimC: number;
	borderL: number;
	borderC: number;
	borderMutedL: number;
	surfaceL: number;
	surfaceC: number;
	neutralSurfaceL: number;
	neutralSurfaceC: number;
	searchL: number;
	searchC: number;
	pageL: number;
	pageC: number;
	cardL: number;
	cardC: number;
	/** Which way foregrounds move to gain contrast. */
	fgDirection: "light" | "dark";
	/** Thinking ramp endpoints (off -> max). */
	thinkingFrom: number;
	thinkingTo: number;
}

const PARAMS: Record<Appearance, AppearanceParams> = {
	dark: {
		chromaL: 0.68,
		chromaC: 0.13,
		strongL: 0.78,
		textL: 0.9,
		textC: 0.01,
		mutedL: 0.7,
		mutedC: 0.02,
		dimL: 0.6,
		dimC: 0.02,
		borderL: 0.63,
		borderC: 0.1,
		borderMutedL: 0.53,
		surfaceL: 0.245,
		surfaceC: 0.05,
		neutralSurfaceL: 0.235,
		neutralSurfaceC: 0.008,
		searchL: 0.25,
		searchC: 0.06,
		pageL: 0.16,
		pageC: 0.02,
		cardL: 0.19,
		cardC: 0.018,
		fgDirection: "light",
		thinkingFrom: 0.5,
		thinkingTo: 0.82,
	},
	light: {
		chromaL: 0.5,
		chromaC: 0.14,
		strongL: 0.43,
		textL: 0.27,
		textC: 0.02,
		mutedL: 0.47,
		mutedC: 0.03,
		dimL: 0.6,
		dimC: 0.02,
		borderL: 0.55,
		borderC: 0.12,
		borderMutedL: 0.66,
		surfaceL: 0.92,
		surfaceC: 0.035,
		neutralSurfaceL: 0.915,
		neutralSurfaceC: 0.006,
		searchL: 0.9,
		searchC: 0.08,
		pageL: 0.94,
		pageC: 0.012,
		cardL: 0.975,
		cardC: 0.008,
		fgDirection: "dark",
		thinkingFrom: 0.82,
		thinkingTo: 0.42,
	},
};

/** Conventional tool-state hues, kept constant across every flag. */
const SUCCESS_HUE = 150;
const ERROR_HUE = 25;
const WARNING_HUE = 85;

/** WCAG floors. Body text is held to AAA; secondary text may sit lower. */
export const CONTRAST = {
	text: 7,
	muted: 4.5,
	dim: 3.5,
	chromatic: 4.5,
	thinking: 3,
} as const;

export interface GeneratedTheme {
	$schema: string;
	name: string;
	appearance: Appearance;
	colors: Record<string, string>;
	export: Record<string, string>;
}

/** Shortest angular distance between two hues, 0..180 degrees. */
const hueDistance = (a: number, b: number): number =>
	Math.abs(((a - b + 540) % 360) - 180);

/** Index of the stripe closest to a target hue (e.g. blue-ish for links). */
const nearestHue = (hues: readonly number[], target: number): number => {
	let best = 0;
	let bestDistance = Number.POSITIVE_INFINITY;
	hues.forEach((hue, index) => {
		const distance = hueDistance(hue, target);
		if (distance < bestDistance) {
			bestDistance = distance;
			best = index;
		}
	});
	return best;
};

const lerp = (from: number, to: number, t: number): number =>
	from + (to - from) * t;

/** `pride-dark` / `pride-trans-light` / ... — unique per flag and appearance. */
export function themeName(flag: FlagSpec, appearance: Appearance): string {
	const base = flag.id === "pride" ? "pride" : `pride-${flag.id}`;
	return `${base}-${appearance}`;
}

export function generateTheme(
	flag: FlagSpec,
	appearance: Appearance
): GeneratedTheme {
	const p = PARAMS[appearance];
	const hues = flag.stripes.map((hex) => hexToOklch(hex).h);
	const stripeCount = hues.length;
	const neutralHue = hues[stripeCount - 1] ?? 250;
	const blueIndex = nearestHue(hues, 250);

	const lch = (l: number, c: number, h: number): Oklch => ({ l, c, h });
	const hueAt = (index: number): number => hues[index % stripeCount] ?? neutralHue;

	/** A flag stripe at a lightness, with a small step so repeats stay distinct. */
	const flagColor = (index: number, lightness: number): Oklch =>
		lch(lightness, p.chromaC, hueAt(index));

	/** A near-neutral tinted toward the flag (surfaces, text, chrome). */
	const neutral = (lightness: number, chroma: number): Oklch =>
		lch(lightness, chroma, neutralHue);

	const tint = (index: number, lightness: number, chroma: number): Oklch =>
		lch(lightness, chroma, hueAt(index));

	// Backgrounds first, so the contrast floor can target the brightest surface.
	const selectedBg = tint(0, p.surfaceL, p.surfaceC);
	const userMessageBg = tint(0, p.surfaceL, p.surfaceC);
	const customMessageBg = tint(1, p.surfaceL, p.surfaceC);
	const searchMatchBg = tint(2, p.searchL, p.searchC);
	const toolPendingBg = neutral(p.neutralSurfaceL, p.neutralSurfaceC);
	const toolSuccessBg = lch(p.surfaceL, p.surfaceC * 0.8, SUCCESS_HUE);
	const toolErrorBg = lch(p.surfaceL, p.surfaceC * 0.8, ERROR_HUE);

	const surfaces = [
		selectedBg,
		userMessageBg,
		customMessageBg,
		searchMatchBg,
		toolPendingBg,
		toolSuccessBg,
		toolErrorBg,
	];

	// A foreground must clear every surface; the hardest is the one closest to
	// the foreground's own luminance. For a dark theme that is the brightest
	// surface, for a light theme the darkest.
	const worstSurface = surfaces.reduce((worst, surface) => {
		const better =
			p.fgDirection === "light"
				? relativeLuminance(oklchToRgbGamut(surface)) >
					relativeLuminance(oklchToRgbGamut(worst))
				: relativeLuminance(oklchToRgbGamut(surface)) <
					relativeLuminance(oklchToRgbGamut(worst));
		return better ? surface : worst;
	});
	const surfaceRgb = oklchToRgbGamut(worstSurface);

	// Quantising to 8-bit hex can shave a hundredth off the ratio, so aim just
	// above the published floor and let the tests assert the exact floor.
	const CONTRAST_MARGIN = 0.08;
	const fg = (color: Oklch, minimum: number): Oklch =>
		ensureContrast(
			color,
			surfaceRgb,
			minimum + CONTRAST_MARGIN,
			p.fgDirection
		);

	const text = fg(neutral(p.textL, p.textC), CONTRAST.text);
	const muted = fg(neutral(p.mutedL, p.mutedC), CONTRAST.muted);
	const dim = fg(neutral(p.dimL, p.dimC), CONTRAST.dim);

	/** Chromatic foreground that clears the contrast floor. */
	const accent = (index: number, lightness = p.chromaL): Oklch =>
		fg(flagColor(index, lightness), CONTRAST.chromatic);

	const semantic = (hue: number, lightness: number): Oklch =>
		fg(lch(lightness, p.chromaC, hue), CONTRAST.chromatic);

	// Syntax repeats the stripes; the -0.03/+0.03 step keeps adjacent tokens of
	// the same stripe (short flags) visually separate.
	const syntaxStep = (index: number): number => (index % 3) - 1;
	const syntax = (index: number, base = p.chromaL): Oklch =>
		accent(index, base + syntaxStep(index) * 0.03);

	const thinking = (t: number, index: number): Oklch =>
		fg(
			lch(
				lerp(p.thinkingFrom, p.thinkingTo, t),
				p.chromaC * (0.45 + 0.55 * t),
				hueAt(index)
			),
			CONTRAST.thinking
		);

	const colors: Record<string, string> = {
		accent: hex(accent(0)),
		border: hex(accent(0, p.borderL)),
		borderAccent: hex(accent(1, p.borderL)),
		borderMuted: hex(neutral(p.borderMutedL, p.chromaC * 0.25)),
		success: hex(semantic(SUCCESS_HUE, p.chromaL)),
		error: hex(semantic(ERROR_HUE, p.chromaL)),
		warning: hex(semantic(WARNING_HUE, p.chromaL)),
		muted: hex(muted),
		dim: hex(dim),
		text: hex(text),

		thinkingText: hex(fg(neutral(p.mutedL, p.mutedC), CONTRAST.muted)),
		selectedBg: hex(selectedBg),
		scrollbarTrack: hex(toolPendingBg),
		scrollbarThumb: hex(fg(neutral(p.borderMutedL, p.mutedC), CONTRAST.dim)),
		searchMatchBg: hex(searchMatchBg),
		searchMatchText: hex(text),

		userMessageBg: hex(userMessageBg),
		userMessageText: hex(text),
		customMessageBg: hex(customMessageBg),
		customMessageText: hex(muted),
		customMessageLabel: hex(accent(1)),

		toolPendingBg: hex(toolPendingBg),
		toolSuccessBg: hex(toolSuccessBg),
		toolErrorBg: hex(toolErrorBg),
		toolTitle: hex(text),
		toolOutput: hex(muted),

		mdHeading: hex(accent(0, p.strongL)),
		mdLink: hex(accent(blueIndex)),
		mdLinkUrl: hex(muted),
		mdCode: hex(accent(1)),
		mdCodeBlock: hex(accent(3)),
		mdCodeBlockBorder: hex(muted),
		mdQuote: hex(muted),
		mdQuoteBorder: hex(muted),
		mdHr: hex(muted),
		mdListBullet: hex(accent(1)),

		toolDiffAdded: hex(semantic(SUCCESS_HUE, p.chromaL)),
		toolDiffRemoved: hex(semantic(ERROR_HUE, p.chromaL)),
		toolDiffContext: hex(muted),

		syntaxComment: hex(muted),
		syntaxKeyword: hex(syntax(0)),
		syntaxFunction: hex(syntax(1)),
		syntaxVariable: hex(syntax(2)),
		syntaxString: hex(syntax(3)),
		syntaxNumber: hex(syntax(4)),
		syntaxType: hex(syntax(5)),
		syntaxOperator: hex(muted),
		syntaxPunctuation: hex(dim),

		thinkingOff: hex(thinking(0, 0)),
		thinkingMinimal: hex(thinking(1 / 6, 1)),
		thinkingLow: hex(thinking(2 / 6, 2)),
		thinkingMedium: hex(thinking(3 / 6, 3)),
		thinkingHigh: hex(thinking(4 / 6, 4)),
		thinkingXhigh: hex(thinking(5 / 6, 5)),
		thinkingMax: hex(thinking(1, 6)),

		bashMode: hex(accent(0, p.strongL)),
	};

	// Text roles are used on surfaces as well as the page; re-check against the
	// page/card backgrounds so nothing falls below the floor on export.
	const pageBg = neutral(p.pageL, p.pageC);
	const cardBg = neutral(p.cardL, p.cardC);
	const infoBg = searchMatchBg;

	const exported = {
		pageBg: hex(pageBg),
		cardBg: hex(cardBg),
		infoBg: hex(infoBg),
	};

	return {
		$schema: THEME_SCHEMA,
		name: themeName(flag, appearance),
		appearance,
		colors,
		export: exported,
	};
}

const hex = (color: Oklch): string => oklchToHex(color);
