/**
 * Small, dependency-free text helpers shared by recall, search, and the store.
 *
 * Everything here works in bytes because the caps that matter are context
 * bytes, not JavaScript characters. A memory full of em dashes should not
 * sneak past a budget written for ASCII.
 */

const STOPWORDS = new Set([
	"a", "about", "after", "again", "all", "also", "am", "an", "and", "any", "are", "as", "at",
	"be", "because", "been", "before", "being", "but", "by", "can", "cant", "could", "did",
	"do", "does", "doing", "dont", "for", "from", "get", "got", "had", "has", "have", "having",
	"he", "her", "here", "hers", "him", "his", "how", "i", "if", "im", "in", "into", "is", "it",
	"its", "ive", "just", "know", "let", "like", "make", "me", "more", "most", "my", "no", "not",
	"now", "of", "off", "on", "once", "one", "only", "or", "other", "our", "out", "over", "own",
	"same", "she", "should", "so", "some", "still", "such", "than", "that", "the", "their",
	"them", "then", "there", "these", "they", "thing", "this", "those", "through", "to", "too",
	"under", "up", "us", "use", "used", "using", "very", "want", "was", "way", "we", "well",
	"were", "what", "when", "where", "which", "while", "who", "why", "will", "with", "would",
	"you", "your", "yours",
]);

/** Lowercase word tokens; keeps identifiers like `pi-review`, `v2`, `use_effect`. */
export function tokenize(text: string): string[] {
	const tokens: string[] = [];
	for (const raw of text.toLowerCase().split(/[^a-z0-9_+#.-]+/)) {
		const token = raw.replace(/^[._-]+|[._-]+$/g, "");
		if (token.length < 3 || token.length > 40) continue;
		if (STOPWORDS.has(token)) continue;
		tokens.push(token);
	}
	return tokens;
}

export function uniqueTokens(text: string): Set<string> {
	return new Set(tokenize(text));
}

/** Jaccard similarity over token sets. Zero for two empty sets. */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
	if (a.size === 0 && b.size === 0) return 0;
	let shared = 0;
	for (const token of a) {
		if (b.has(token)) shared++;
	}
	return shared / (a.size + b.size - shared);
}

export function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/** Cut a string to at most `maxBytes`, never splitting a UTF-8 sequence. */
export function truncateBytes(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	if (byteLength(text) <= maxBytes) return text;
	let low = 0;
	let high = text.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (byteLength(text.slice(0, mid)) <= maxBytes) low = mid;
		else high = mid - 1;
	}
	return text.slice(0, low);
}

export interface CappedText {
	text: string;
	truncated: boolean;
	bytes: number;
}

/**
 * Apply a line cap and a byte cap, marking the result when either cut
 * something. The marker is added only when it fits, so a caller that already
 * budgets exact bytes is never surprised by growth.
 */
export function capText(text: string, maxBytes: number, maxLines: number): CappedText {
	let out = text.trim();
	let truncated = false;
	const lines = out.split("\n");
	if (lines.length > maxLines) {
		out = lines.slice(0, maxLines).join("\n");
		truncated = true;
	}
	if (byteLength(out) > maxBytes) {
		const marker = "\n… truncated";
		const room = maxBytes - byteLength(marker);
		out = room > 0 ? `${truncateBytes(out, room)}${marker}` : truncateBytes(out, maxBytes);
		truncated = true;
	}
	return { text: out, truncated, bytes: byteLength(out) };
}

/** Collapse whitespace so a multi-line body can fit in one index line. */
export function oneLine(text: string, maxChars: number): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed.length <= maxChars) return collapsed;
	return `${collapsed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

/**
 * Lowercase, punctuation-free form used to compare memory names.
 *
 * Unicode-aware: a title in Japanese or Cyrillic keeps its letters instead of
 * collapsing to an empty string, which would make every such title "the same"
 * and overwrite memories or delete the wrong one.
 */
export function normalizeName(name: string): string {
	const normalized = name
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
		.replace(/\s+/g, " ");
	return normalized.length > 0 ? normalized : name.trim().toLowerCase();
}

/** Filename-safe slug for a memory name. */
export function slugify(name: string, maxChars = 48): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, maxChars)
		.replace(/_+$/g, "");
	return slug.length > 0 ? slug : "memory";
}

/** Format a duration in whole units, for `/memory status`. */
export function formatAge(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "never";
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}
