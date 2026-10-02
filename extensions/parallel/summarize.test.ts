import { describe, expect, it } from "vitest";
import { buildSummaryPrompt } from "./summarize.ts";

describe("buildSummaryPrompt", () => {
	it("includes the request and each page with its URL", () => {
		const prompt = buildSummaryPrompt("What changed in 2026?", [
			{ url: "https://example.com/a", title: "A", content: "alpha" },
			{ url: "https://example.com/b", content: "beta" },
		]);
		expect(prompt).toContain("What changed in 2026?");
		expect(prompt).toContain('<page url="https://example.com/a">');
		expect(prompt).toContain("# A");
		expect(prompt).toContain("alpha");
		expect(prompt).toContain('<page url="https://example.com/b">');
	});

	it("escapes attribute characters in URLs", () => {
		const prompt = buildSummaryPrompt("q", [
			{ url: 'https://example.com/?a="b"&c=<d>', content: "body" },
		]);
		expect(prompt).toContain("&quot;");
		expect(prompt).toContain("&amp;");
		expect(prompt).not.toContain('url="https://example.com/?a="b"');
	});
});
