/**
 * Perceptual color utilities for the pride theme generator.
 *
 * Everything is authored in OKLCH because it is perceptually uniform: equal
 * lightness changes look equal at every hue, and chroma is bounded by the sRGB
 * gamut in a way that is easy to clamp. The generator emits plain hex so the
 * resolved color is exact and the WCAG contrast checks match what the terminal
 * will actually render.
 */

export interface Rgb {
	/** Channels in 0..1, sRGB, not necessarily in gamut until mapped. */
	r: number;
	g: number;
	b: number;
}

export interface Oklch {
	/** Perceptual lightness, 0..1. */
	l: number;
	/** Chroma (colorfulness), 0..~0.37. */
	c: number;
	/** Hue in degrees, 0..360. */
	h: number;
}

export const clamp = (value: number, low: number, high: number): number =>
	Math.min(high, Math.max(low, value));

export const clamp01 = (value: number): number => clamp(value, 0, 1);

const srgbToLinear = (channel: number): number =>
	channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

const linearToSrgb = (channel: number): number =>
	channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;

/** Parse `#rgb` or `#rrggbb` (case-insensitive). */
export function hexToRgb(hex: string): Rgb {
	const value = hex.startsWith("#") ? hex.slice(1) : hex;
	const full =
		value.length === 3
			? value
					.split("")
					.map((char) => char + char)
					.join("")
			: value;
	if (!/^[0-9a-f]{6}$/i.test(full)) {
		throw new Error(`Not a hex color: ${hex}`);
	}
	return {
		r: Number.parseInt(full.slice(0, 2), 16) / 255,
		g: Number.parseInt(full.slice(2, 4), 16) / 255,
		b: Number.parseInt(full.slice(4, 6), 16) / 255,
	};
}

export function rgbToHex({ r, g, b }: Rgb): string {
	const channel = (value: number): string =>
		Math.round(clamp01(value) * 255)
			.toString(16)
			.padStart(2, "0");
	return `#${channel(r)}${channel(g)}${channel(b)}`;
}

// Björn Ottosson's OKLab matrices, operating on linear sRGB.
export function rgbToOklch({ r, g, b }: Rgb): Oklch {
	const lr = srgbToLinear(r);
	const lg = srgbToLinear(g);
	const lb = srgbToLinear(b);

	const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
	const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
	const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);

	const okL = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
	const okA = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
	const okB = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;

	const chroma = Math.sqrt(okA * okA + okB * okB);
	const hue = (Math.atan2(okB, okA) * 180) / Math.PI;
	return { l: okL, c: chroma, h: (hue + 360) % 360 };
}

/** Convert OKLCH to raw sRGB; channels may fall outside 0..1 (out of gamut). */
export function oklchToRgb({ l, c, h }: Oklch): Rgb {
	const radians = (h * Math.PI) / 180;
	const okA = c * Math.cos(radians);
	const okB = c * Math.sin(radians);

	const l3 = (l + 0.3963377774 * okA + 0.2158037573 * okB) ** 3;
	const m3 = (l - 0.1055613458 * okA - 0.0638541728 * okB) ** 3;
	const s3 = (l - 0.0894841775 * okA - 1.291485548 * okB) ** 3;

	return {
		r: linearToSrgb(4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3),
		g: linearToSrgb(-1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3),
		b: linearToSrgb(-0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3),
	};
}

const GAMUT_EPSILON = 1e-4;

export function inGamut({ r, g, b }: Rgb): boolean {
	return (
		r >= -GAMUT_EPSILON &&
		r <= 1 + GAMUT_EPSILON &&
		g >= -GAMUT_EPSILON &&
		g <= 1 + GAMUT_EPSILON &&
		b >= -GAMUT_EPSILON &&
		b <= 1 + GAMUT_EPSILON
	);
}

const clampRgb = ({ r, g, b }: Rgb): Rgb => ({
	r: clamp01(r),
	g: clamp01(g),
	b: clamp01(b),
});

/**
 * Map an OKLCH color into sRGB by holding lightness and hue and reducing
 * chroma until it fits. This is the same strategy pi uses for OKLCH themes, so
 * the emitted hex matches what pi would render.
 */
export function oklchToRgbGamut(color: Oklch): Rgb {
	const l = clamp01(color.l);
	const chroma = Math.max(0, color.c);
	const raw = oklchToRgb({ l, c: chroma, h: color.h });
	if (inGamut(raw)) {
		return clampRgb(raw);
	}

	let low = 0;
	let high = chroma;
	for (let i = 0; i < 24; i += 1) {
		const mid = (low + high) / 2;
		if (inGamut(oklchToRgb({ l, c: mid, h: color.h }))) {
			low = mid;
		} else {
			high = mid;
		}
	}
	return clampRgb(oklchToRgb({ l, c: low, h: color.h }));
}

export function oklchToHex(color: Oklch): string {
	return rgbToHex(oklchToRgbGamut(color));
}

export function hexToOklch(hex: string): Oklch {
	return rgbToOklch(hexToRgb(hex));
}

/** Transform only the lightness, keeping chroma and hue. */
export function withLightness(color: Oklch, lightness: number): Oklch {
	return { ...color, l: clamp01(lightness) };
}

/** WCAG relative luminance of an sRGB color. */
export function relativeLuminance({ r, g, b }: Rgb): number {
	return (
		0.2126 * srgbToLinear(clamp01(r)) +
		0.7152 * srgbToLinear(clamp01(g)) +
		0.0722 * srgbToLinear(clamp01(b))
	);
}

/** WCAG contrast ratio between two colors, from 1 to 21. */
export function contrastRatio(first: Rgb, second: Rgb): number {
	const a = relativeLuminance(first);
	const b = relativeLuminance(second);
	const lighter = Math.max(a, b);
	const darker = Math.min(a, b);
	return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Move lightness away from `background` until `color` reaches `minimum`
 * contrast, keeping chroma and hue. `direction` is the side of the background
 * the foreground should move toward: a dark background pushes toward light.
 */
export function ensureContrast(
	color: Oklch,
	background: Rgb,
	minimum: number,
	direction: "light" | "dark"
): Oklch {
	const step = 0.004;
	let lightness = clamp01(color.l);
	const passes = (candidate: Oklch): boolean =>
		contrastRatio(oklchToRgbGamut(candidate), background) >= minimum;

	if (passes(withLightness(color, lightness))) {
		return withLightness(color, lightness);
	}

	for (let i = 0; i < 260; i += 1) {
		lightness += direction === "light" ? step : -step;
		if (lightness <= 0 || lightness >= 1) {
			break;
		}
		if (passes(withLightness(color, lightness))) {
			return withLightness(color, lightness);
		}
	}
	return withLightness(color, clamp(lightness, 0, 1));
}

/** Linear interpolation between two OKLCH colors (shortest hue arc). */
export function mixOklch(from: Oklch, to: Oklch, t: number): Oklch {
	const delta = ((to.h - from.h + 540) % 360) - 180;
	return {
		l: from.l + (to.l - from.l) * t,
		c: from.c + (to.c - from.c) * t,
		h: (from.h + delta * t + 360) % 360,
	};
}
