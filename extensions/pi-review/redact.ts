/**
 * Credential-shaped strings, removed from text pi-review publishes.
 *
 * The transcript is safe by construction — it is the model stream, and the
 * provider key lives only in the environment. The text this package *copies out*
 * is not: a provider error, a `gh` failure, or a model answering with a token it
 * read is somebody else's text, and it ends up in a public pull-request comment,
 * the step summary, and the uploaded conclusion.
 *
 * Vendor-prefixed formats are matched without a leading word boundary on
 * purpose: runtime output frequently puts a word character directly against the
 * value (an ANSI colour code that ends in `m`, a JSON escape such as `\n`), and
 * a boundary assertion there would leave the credential in place.
 */

interface RedactionRule {
	pattern: RegExp;
	marker: string;
}

const RULES: RedactionRule[] = [
	// Classic, OAuth, user-to-server, installation, and refresh tokens.
	{ pattern: /gh[pousr]_[A-Za-z0-9]{36}/g, marker: "[REDACTED_GITHUB_TOKEN]" },
	// Fine-grained personal access tokens.
	{ pattern: /github_pat_[A-Za-z0-9_]{11,221}/g, marker: "[REDACTED_GITHUB_TOKEN]" },
	{ pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g, marker: "[REDACTED_ANTHROPIC_KEY]" },
	// AWS access key ids, which are all uppercase and self-anchoring.
	{ pattern: /(?:AKIA|ASIA)[A-Z0-9]{16}/g, marker: "[REDACTED_AWS_KEY_ID]" },
	{ pattern: /xox[abpsr]-[A-Za-z0-9-]{10,}/g, marker: "[REDACTED_SLACK_TOKEN]" },
	// Three base64url segments, the first two of which start with `eyJ` (the
	// base64 of `{"`).
	{
		pattern: /eyJ[A-Za-z0-9_-]{10,4000}\.eyJ[A-Za-z0-9_-]{10,4000}\.[A-Za-z0-9_-]{10,4000}/g,
		marker: "[REDACTED_JWT]",
	},
];

/**
 * Samples every implementation must redact, used by `redact.test.ts` and by the
 * reusable workflow's test. The bash `redact()` in that workflow is a second
 * implementation of this list, so the two are pinned to the same fixtures: a
 * shape added here without adding it there fails the workflow test.
 */
export const SECRET_SAMPLES: string[] = [
	`token ghp_${"a".repeat(36)} here`,
	`token gho_${"b".repeat(36)} here`,
	`token ghu_${"c".repeat(36)} here`,
	`token ghs_${"d".repeat(36)} here`,
	`token ghr_${"e".repeat(36)} here`,
	`token github_pat_${"f".repeat(22)}_${"g".repeat(40)} here`,
	`key sk-ant-api03-${"h".repeat(40)} here`,
	"key AKIAIOSFODNN7EXAMPLE here",
	"key ASIAIOSFODNN7EXAMPLE here",
	`key xoxb-${"123456789012"}-${"abcdefghijkl"} here`,
	`jwt eyJ${"a".repeat(20)}.eyJ${"b".repeat(20)}.${"c".repeat(20)} here`,
];

export function redactSecrets(text: string): string {
	let out = text;
	for (const rule of RULES) out = out.replace(rule.pattern, rule.marker);
	return out;
}
