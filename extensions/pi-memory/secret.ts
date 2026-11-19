/**
 * Secret screening for memory writes.
 *
 * Persistent memory is the worst possible place for a credential: it is
 * loaded into future sessions automatically and survives the conversation that
 * leaked it. The screens below cover the shapes that actually show up in a
 * coding session, not every possible high-entropy string.
 *
 * A hit is reported by label and field only. The secret itself is never logged
 * or echoed back, so a refused write cannot turn the error message into a
 * second leak.
 */

export interface SecretHit {
	/** What the value looked like, e.g. "GitHub token". */
	label: string;
	/** Which memory field matched, e.g. "body". */
	field: string;
	/** Offset inside that field, useful in a debug log without the value. */
	index: number;
}

interface Rule {
	label: string;
	pattern: RegExp;
	/** Values that are obviously documentation, not credentials. */
	allowPlaceholder?: boolean;
}

const PLACEHOLDER = /(example|placeholder|redacted|dummy|sample|your[-_]?|<[^>]*>|\bxxxx+\b|\.\.\.)/i;

const RULES: Rule[] = [
	{
		label: "PEM private key",
		pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/,
	},
	{
		label: "AWS access key id",
		pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
		allowPlaceholder: true,
	},
	{
		label: "GitHub token",
		pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
		allowPlaceholder: true,
	},
	{
		label: "Slack token",
		pattern: /\bxox[abprs]-[A-Za-z0-9-]{8,}\b/,
		allowPlaceholder: true,
	},
	{
		label: "Anthropic API key",
		pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
		allowPlaceholder: true,
	},
	{
		label: "OpenAI API key",
		pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/,
		allowPlaceholder: true,
	},
	{
		label: "Stripe key",
		pattern: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/,
		allowPlaceholder: true,
	},
	{
		label: "Google API key",
		pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/,
		allowPlaceholder: true,
	},
	{
		label: "JSON Web Token",
		pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
	},
	{
		label: "Bearer token",
		pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/,
		allowPlaceholder: true,
	},
	{
		label: "connection string with a password",
		pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|mssql):\/\/[^\s:@/]+:[^\s@/]+@/i,
		allowPlaceholder: true,
	},
];

/**
 * `password: hunter2hunter2` and friends. The value must look like a
 * credential (long enough, no variable reference) before it counts, otherwise
 * ordinary prose about a `token` field would be refused.
 */
const ASSIGNMENT =
	/(?:api[_-]?key|access[_-]?key|secret(?:[_-]?key)?|client[_-]?secret|password|passwd|auth[_-]?token)\s*[:=]\s*["']?(?!\$|process\.|env\.|os\.)([A-Za-z0-9_\-./+=]{16,})["']?/gi;

function assignmentHit(text: string): { label: string; index: number } | undefined {
	ASSIGNMENT.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = ASSIGNMENT.exec(text)) !== null) {
		const value = match[1] ?? "";
		if (PLACEHOLDER.test(value)) continue;
		// A long lowercase word is a sentence, not a key. Require a digit, a
		// case change, or a symbol-heavy value.
		if (!/[0-9]/.test(value) && !/[A-Z]/.test(value) && !/[+/=]/.test(value)) continue;
		return { label: "credential assignment", index: match.index };
	}
	return undefined;
}

/** The first secret-shaped value in `text`, or undefined. */
export function findSecret(text: string): { label: string; index: number } | undefined {
	for (const rule of RULES) {
		const match = rule.pattern.exec(text);
		if (!match) continue;
		if (rule.allowPlaceholder && PLACEHOLDER.test(match[0])) continue;
		return { label: rule.label, index: match.index };
	}
	return assignmentHit(text);
}

/** Screen every field of a write; returns the first hit with its field name. */
export function scanMemoryFields(
	fields: Record<string, string | undefined>
): SecretHit | undefined {
	for (const [field, value] of Object.entries(fields)) {
		if (!value) continue;
		const hit = findSecret(value);
		if (hit) return { label: hit.label, field, index: hit.index };
	}
	return undefined;
}

/** Human-facing refusal text. Deliberately omits the value. */
export function secretRefusal(hit: SecretHit): string {
	return `Refused to save: the ${hit.field} looks like a ${hit.label}. Memory must never hold credentials; reference the secret by name instead.`;
}
