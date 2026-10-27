import { describe, expect, it, vi } from "vitest";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import {
	normalizeMaxItems,
	renderWindow,
} from "./window.ts";

function component(...lines: string[]): Component & {
	render: ReturnType<typeof vi.fn>;
} {
	const render = vi.fn(() => lines);
	return {
		render,
		invalidate: () => {},
	};
}

const options = {
	marker: (hidden: number, total: number) => `hidden:${hidden}/${total}`,
	styleMarker: (text: string) => text,
};

describe("renderWindow", () => {
	it("renders everything and no marker when under the limit", () => {
		const first = component("a", "b");
		const second = component("c");

		const result = renderWindow([first, second], 40, {
			...options,
			maxItems: 10,
		});

		expect(result.hidden).toBe(0);
		expect(result.lines).toEqual(["a", "b", "c"]);
		expect(result.visible).toHaveLength(2);
	});

	it("renders only the trailing components", () => {
		const first = component("old");
		const second = component("middle");
		const third = component("new");

		const result = renderWindow([first, second, third], 40, {
			...options,
			maxItems: 2,
		});

		expect(result.hidden).toBe(1);
		expect(result.lines).toEqual(["hidden:1/3", "middle", "new"]);
		expect(first.render).not.toHaveBeenCalled();
		expect(second.render).toHaveBeenCalledOnce();
		expect(third.render).toHaveBeenCalledOnce();
	});

	it("treats zero and non-finite limits as unlimited", () => {
		const first = component("a");
		const second = component("b");

		for (const maxItems of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			const result = renderWindow([first, second], 40, {
				...options,
				maxItems,
			});
			expect(result.hidden).toBe(0);
			expect(result.lines).toEqual(["a", "b"]);
		}
	});

	it("truncates a marker that is wider than the terminal", () => {
		const result = renderWindow([component("a"), component("b")], 10, {
			maxItems: 1,
			marker: () => "a very long hidden-history marker",
			styleMarker: (text) => text,
		});

		expect(result.hidden).toBe(1);
		expect(visibleWidth(result.lines[0] ?? "")).toBeLessThanOrEqual(10);
		expect(result.lines[1]).toBe("b");
	});
});

describe("normalizeMaxItems", () => {
	it("floors positive values", () => {
		expect(normalizeMaxItems(12.9)).toBe(12);
	});

	it("collapses invalid values to unlimited", () => {
		expect(normalizeMaxItems(0)).toBe(0);
		expect(normalizeMaxItems(-4)).toBe(0);
		expect(normalizeMaxItems(Number.NaN)).toBe(0);
	});
});
