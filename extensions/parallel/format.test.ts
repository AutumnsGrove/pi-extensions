import { describe, expect, it } from "vitest";
import type { ParallelExtractResponse, ParallelSearchResponse } from "./client.ts";
import { clipPages, formatExtractResults, formatSearchResults, pageContents } from "./format.ts";

const searchResponse: ParallelSearchResponse = {
	search_id: "search_1",
	results: [
		{
			url: "https://example.com/a",
			title: "Example A",
			publish_date: "2026-01-02",
			excerpts: ["First excerpt", "Second excerpt"],
		},
		{
			url: "https://example.com/b",
			title: null,
			excerpts: ["Only excerpt"],
		},
	],
};

const extractResponse: ParallelExtractResponse = {
	extract_id: "extract_1",
	results: [
		{
			url: "https://example.com/a",
			title: "Example A",
			excerpts: ["Excerpt body"],
			full_content: "Full body",
		},
	],
};

describe("formatSearchResults", () => {
	it("renders numbered results with markdown links and excerpts", () => {
		const text = formatSearchResults(searchResponse);
		expect(text).toContain("1. [Example A](https://example.com/a)");
		expect(text).toContain("Published: 2026-01-02");
		expect(text).toContain("First excerpt");
		expect(text).toContain("2. [https://example.com/b](https://example.com/b)");
	});

	it("handles an empty result set", () => {
		expect(formatSearchResults({ search_id: "s", results: [] })).toBe("Parallel returned no results.");
	});
});

describe("pageContents", () => {
	it("prefers full content when requested and falls back to excerpts", () => {
		expect(pageContents(extractResponse, true)[0]?.content).toBe("Full body");
		expect(pageContents(extractResponse, false)[0]?.content).toBe("Excerpt body");
	});

	it("falls back to excerpts when full content is missing", () => {
		const noFull = { ...extractResponse, results: [{ ...extractResponse.results[0]!, full_content: null }] };
		expect(pageContents(noFull, true)[0]?.content).toBe("Excerpt body");
	});
});

describe("formatExtractResults", () => {
	it("includes the page content and link", () => {
		const text = formatExtractResults(extractResponse);
		expect(text).toContain("[Example A](https://example.com/a)");
		expect(text).toContain("Full body");
	});
});

describe("clipPages", () => {
	it("truncates pages to fit the budget", () => {
		const pages = [{ url: "https://example.com", content: "x".repeat(10_000) }];
		const clipped = clipPages(pages, 2_000);
		expect(clipped[0]?.content.length).toBeLessThan(2_100);
		expect(clipped[0]?.content).toContain("truncated");
	});

	it("leaves short pages untouched", () => {
		const pages = [{ url: "https://example.com", content: "short" }];
		expect(clipPages(pages, 2_000)[0]?.content).toBe("short");
	});
});
