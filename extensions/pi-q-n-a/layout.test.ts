import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
	chooseLayout,
	COLUMN_GAP,
	composeColumns,
	MAX_PREVIEW_LINES,
	padRight,
	renderPreviewBox,
	type ThemeLike,
} from "./layout.ts";

const theme: ThemeLike = {
	fg: (_token, text) => text,
	bg: (_token, text) => text,
	bold: (text) => text,
};

describe("chooseLayout", () => {
	it("uses the full width when there is no preview pane", () => {
		expect(chooseLayout(100, false)).toEqual({
			sideBySide: false,
			optionWidth: 100,
			previewWidth: 100,
			gap: 0,
		});
	});

	it("splits wide terminals into option and preview columns", () => {
		const layout = chooseLayout(120, true);
		expect(layout.sideBySide).toBe(true);
		expect(layout.optionWidth + layout.gap + layout.previewWidth).toBe(120);
		expect(layout.gap).toBe(COLUMN_GAP);
	});

	it("stacks when side by side would be too narrow", () => {
		const layout = chooseLayout(40, true);
		expect(layout.sideBySide).toBe(false);
		expect(layout.optionWidth).toBe(40);
	});

	it("clamps the preview pane span", () => {
		expect(chooseLayout(400, true).previewWidth).toBe(60);
		expect(chooseLayout(100, true).previewWidth).toBe(38);
	});

	it("never returns a negative width", () => {
		expect(chooseLayout(0, true).optionWidth).toBeGreaterThanOrEqual(1);
	});
});

describe("padRight", () => {
	it("leaves wide-enough lines alone", () => {
		expect(padRight("abcd", 2)).toBe("abcd");
	});

	it("pads short lines to the requested width", () => {
		expect(padRight("ab", 5)).toBe("ab   ");
	});
});

describe("composeColumns", () => {
	it("pads the left column so the right column aligns", () => {
		const lines = composeColumns(["a", "bb"], ["RIGHT", "RIGHT2"], 4, 2);
		expect(lines).toEqual(["a     RIGHT", "bb    RIGHT2"]);
	});

	it("fills missing rows", () => {
		const lines = composeColumns(["a"], ["r1", "r2"], 2, 1);
		expect(lines).toEqual(["a  r1", "   r2"]);
	});
});

describe("renderPreviewBox", () => {
	it("renders a centered, full-width box", () => {
		const lines = renderPreviewBox("a\nbb", undefined, "Preview", 30, theme);
		expect(lines[0]?.startsWith("┌")).toBe(true);
		expect(lines[lines.length - 1]?.startsWith("└")).toBe(true);
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(30);
		}
	});

	it("shows a placeholder without a preview", () => {
		const lines = renderPreviewBox(undefined, undefined, "", 20, theme);
		expect(lines.join("\n")).toContain("(no preview)");
	});

	it("clips previews to the maximum line count", () => {
		const preview = Array.from({ length: MAX_PREVIEW_LINES + 5 }, (_v, i) => `line ${i}`).join("\n");
		const lines = renderPreviewBox(preview, undefined, "big", 30, theme);
		expect(lines.join("\n")).toContain("more lines");
		expect(lines.length).toBe(MAX_PREVIEW_LINES + 3); // top + max lines + hint + bottom
	});
});
