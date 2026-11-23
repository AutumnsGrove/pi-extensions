/**
 * The data side of "PR text is untrusted".
 *
 * `prompt.ts` fences PR text and tells the model not to follow instructions
 * inside it. That is an instruction-level defence, and a good one, but it says
 * nothing about *content*: a pull request can put an instruction where a human
 * reading the diff on GitHub will not see it, and the model will. The channels
 * are well known and cheap to close:
 *
 * - `<!-- ... -->` is not rendered at all.
 * - Zero-width characters, soft hyphens, and the bidi overrides render as
 *   nothing while still being tokens the model reads.
 * - Markdown image alt text and link titles are rendered small or not at all.
 * - HTML attributes such as `alt=`, `title=`, `aria-label=`, `data-*` and
 *   `placeholder=` carry text no reader looks at.
 *
 * This mirrors what `anthropics/claude-code-action` (MIT) does in
 * `src/github/utils/sanitizer.ts`, whose security doc states the reasoning. The
 * shapes are the same; the composition below is ours because the prompt builder
 * escapes its own fence tags and the two steps have to be ordered.
 *
 * What this is not: a sandbox. It removes the invisible channels, not a
 * determined injection in plain sight, which is what the fence and the system
 * instructions are for.
 */

/** `<!-- ... -->`, including multi-line, non-greedy. */
export function stripHtmlComments(text: string): string {
	return text.replace(/<!--[\s\S]*?-->/g, "");
}

/**
 * Characters that occupy no visible space: zero-width space/joiner/non-joiner,
 * the byte-order mark, soft hyphens, C0 and C1 controls other than tab, newline
 * and carriage return, and the bidi embedding/override/isolate controls.
 */
export function stripInvisibleCharacters(text: string): string {
	let out = text;
	out = out.replace(/[\u200B\u200C\u200D\uFEFF]/g, "");
	out = out.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
	out = out.replace(/\u00AD/g, "");
	out = out.replace(/[\u202A-\u202E\u2066-\u2069]/g, "");
	return out;
}

/**
 * Alt text on images, inline and reference style. A reviewer does not need it,
 * and `![ignore all previous instructions](url)` is a single line of noise to a
 * human.
 */
export function stripMarkdownImageAltText(text: string): string {
	let out = text;
	out = out.replace(/!\[[^\]]*\]\(/g, "![](");
	out = out.replace(/!\[[^\]]*\](\[[^\]]*\])/g, "![]$1");
	return out;
}

/** Link titles: `[text](url "title")` and the single-quoted form. */
export function stripMarkdownLinkTitles(text: string): string {
	let out = text;
	out = out.replace(/(\[[^\]]*\]\([^)]+)\s+"[^"]*"/g, "$1");
	out = out.replace(/(\[[^\]]*\]\([^)]+)\s+'[^']*'/g, "$1");
	return out;
}

/**
 * The hidden attributes on raw HTML in a body. Quoted values are matched per
 * quote type, so a value containing the other quote character (an apostrophe
 * inside a double-quoted value) does not end the match early and mangle the
 * surrounding text.
 */
export function stripHiddenAttributes(text: string): string {
	let out = text;
	for (const attribute of ["alt", "title", "aria-label", "placeholder"]) {
		out = out.replace(new RegExp(`\\s${attribute}\\s*=\\s*"[^"]*"`, "gi"), "");
		out = out.replace(new RegExp(`\\s${attribute}\\s*=\\s*'[^']*'`, "gi"), "");
		out = out.replace(new RegExp(`\\s${attribute}\\s*=\\s*[^\\s>]+`, "gi"), "");
	}
	for (const quote of ['"[^"]*"', "'[^']*'", "[^\\s>]+"]) {
		out = out.replace(new RegExp(`\\sdata-[a-zA-Z0-9-]+\\s*=\\s*${quote}`, "gi"), "");
	}
	return out;
}

/**
 * Decode numeric entities, because `&#104;idden` is legible to the model and
 * not to a `grep` for the word. Only printable ASCII is decoded and everything
 * else is dropped, so an entity cannot smuggle a control character back in that
 * `stripInvisibleCharacters` has just removed.
 */
export function normalizeHtmlEntities(text: string): string {
	const decode = (code: number): string =>
		code >= 32 && code <= 126 ? String.fromCharCode(code) : "";
	let out = text;
	out = out.replace(/&#(\d+);/g, (_, decimal: string) => decode(Number.parseInt(decimal, 10)));
	out = out.replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => decode(Number.parseInt(hex, 16)));
	return out;
}

/**
 * Order matters: entities are decoded last, so a decoded `<` is then subject to
 * fence escaping by the caller (`neutralizeFences`), and a decoded control
 * character cannot survive `stripInvisibleCharacters` because only printable
 * ASCII is decoded.
 */
export function sanitizeUntrusted(text: string): string {
	let out = text;
	out = stripHtmlComments(out);
	out = stripInvisibleCharacters(out);
	out = stripMarkdownImageAltText(out);
	out = stripMarkdownLinkTitles(out);
	out = stripHiddenAttributes(out);
	out = normalizeHtmlEntities(out);
	return out;
}

/**
 * The diff gets the invisible channels and nothing else.
 *
 * `sanitizeUntrusted` strips alt text and decodes entities, which would change
 * code being reviewed (`&#39;` in an HTML file, `alt=` in a test fixture). What
 * is left here — HTML comments and invisible characters — cannot carry
 * reviewable meaning, and is exactly where an instruction hides. Inline anchors
 * are validated against the untouched `target.diff`, so this cannot move a
 * comment's position.
 */
export function sanitizeDiff(text: string): string {
	return stripInvisibleCharacters(stripHtmlComments(text));
}
