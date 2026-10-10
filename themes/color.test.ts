import { describe, expect, it } from "vitest";
import {
	contrastRatio,
	ensureContrast,
	hexToOklch,
	hexToRgb,
	inGamut,
	oklchToHex,
	oklchToRgb,
	oklchToRgbGamut,
	relativeLuminance,
	rgbToHex,
} from "./color.ts";

const channelDelta = (
	first: { r: number; g: number; b: number },
	second: { r: number; g: number; b: number }
): number =>
	Math.max(
		Math.abs(first.r - second.r),
		Math.abs(first.g - second.g),
		Math.abs(first.b - second.b)
	);

describe("hex <-> rgb", () => {
	it("round-trips six-digit hex", () => {
		for (const hex of ["#000000", "#ffffff", "#e40303", "#5bcffa", "#750787"]) {
			expect(rgbToHex(hexToRgb(hex))).toBe(hex);
		}
	});

	it("expands three-digit hex", () => {
		expect(rgbToHex(hexToRgb("#0af"))).toBe("#00aaff");
	});

	it("rejects malformed values", () => {
		expect(() => hexToRgb("#12345")).toThrow();
		expect(() => hexToRgb("nope")).toThrow();
	});
});

describe("oklch", () => {
	it("round-trips sRGB through OKLCH", () => {
		for (const hex of ["#e40303", "#ff8c00", "#008026", "#2a66ff", "#750787"]) {
			const round = oklchToHex(hexToOklch(hex));
			expect(channelDelta(hexToRgb(round), hexToRgb(hex))).toBeLessThan(0.01);
		}
	});

	it("places white and black at the lightness extremes", () => {
		expect(hexToOklch("#ffffff").l).toBeCloseTo(1, 1);
		expect(hexToOklch("#000000").l).toBeCloseTo(0, 1);
	});

	it("always maps into the sRGB gamut", () => {
		for (let hue = 0; hue < 360; hue += 15) {
			const { r, g, b } = oklchToRgbGamut({ l: 0.7, c: 0.4, h: hue });
			for (const channel of [r, g, b]) {
				expect(channel).toBeGreaterThanOrEqual(0);
				expect(channel).toBeLessThanOrEqual(1);
			}
		}
	});

	it("reduces chroma rather than clipping an out-of-gamut color", () => {
		const mapped = oklchToRgbGamut({ l: 0.5, c: 0.4, h: 264 });
		const raw = oklchToRgb({ l: 0.5, c: 0.4, h: 264 });
		// The raw value overflows; the mapped value must stay inside.
		expect(inGamut(mapped)).toBe(true);
		expect(Math.max(raw.r, raw.g, raw.b)).toBeGreaterThan(1);
	});
});

describe("contrast", () => {
	it("reports the full black/white range", () => {
		expect(contrastRatio(hexToRgb("#000000"), hexToRgb("#ffffff"))).toBeCloseTo(
			21,
			5
		);
		expect(contrastRatio(hexToRgb("#777777"), hexToRgb("#777777"))).toBeCloseTo(
			1,
			5
		);
	});

	it("is symmetric", () => {
		const a = hexToRgb("#e40303");
		const b = hexToRgb("#101010");
		expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10);
	});

	it("uses relative luminance weighting", () => {
		// Green contributes more luminance than blue at equal channel value.
		expect(relativeLuminance(hexToRgb("#00ff00"))).toBeGreaterThan(
			relativeLuminance(hexToRgb("#0000ff"))
		);
	});

	it("moves lightness until the floor is met", () => {
		const background = hexToRgb("#202020");
		const lifted = ensureContrast(
			{ l: 0.4, c: 0.1, h: 20 },
			background,
			4.5,
			"light"
		);
		expect(contrastRatio(oklchToRgbGamut(lifted), background)).toBeGreaterThanOrEqual(
			4.5
		);
		expect(lifted.h).toBe(20);
	});
});
