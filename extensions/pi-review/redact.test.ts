import { describe, expect, it } from "vitest";
import { SECRET_SAMPLES, redactSecrets } from "./redact.ts";

describe("redactSecrets", () => {
	it("removes every vendor shape it claims to", () => {
		for (const sample of SECRET_SAMPLES) {
			const redacted = redactSecrets(sample);
			expect(redacted).not.toBe(sample);
			// The whole value goes, not just its prefix: the marker replaces it
			// and nothing of the original survives around it.
			expect(redacted).toMatch(/\[REDACTED_[A-Z_]+\]/);
			expect(redacted).toContain(" here");
		}
	});

	it("leaves ordinary text alone", () => {
		const messages = [
			"429: the inference service is overloaded",
			"gh api failed (exit 1): HTTP 422 Validation Failed",
			"the review hit the model's output limit",
			// Long identifiers that merely look like they could be secrets.
			"src/pi-review/redact.ts",
			"94e2d1c0b8f7a6e5d4c3b2a1f0e9d8c7b6a5f4e3",
		];
		for (const message of messages) expect(redactSecrets(message)).toBe(message);
	});

	it("redacts a value that follows an ANSI colour code", () => {
		// The boundary case from `claude-code-action`: a word character (`m`)
		// sits directly against the token, so a `\b` assertion would miss it.
		const output = `\u001b[31mghp_${"a".repeat(36)}\u001b[0m`;
		expect(redactSecrets(output)).toBe("\u001b[31m[REDACTED_GITHUB_TOKEN]\u001b[0m");
	});

	it("redacts a value that follows a JSON newline escape", () => {
		const output = `{"detail":"boom\\nghp_${"a".repeat(36)}"}`;
		expect(redactSecrets(output)).not.toContain("ghp_");
	});

	it("redacts every occurrence, not just the first", () => {
		const output = `ghp_${"a".repeat(36)} and again ghp_${"b".repeat(36)}`;
		expect(redactSecrets(output)).toBe("[REDACTED_GITHUB_TOKEN] and again [REDACTED_GITHUB_TOKEN]");
	});
});
