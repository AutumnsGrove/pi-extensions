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
 * - Every HTML attribute value is invisible to the reader, whatever it is
 *   called, so all of them go except `href` and `src`.
 *
 * The diff is deliberately left alone: `<!-- -->` in a diff is source text a
 * human sees, and a zero-width character inside a diff *is* the finding.
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
 * Characters that occupy no visible space. Every range here renders as nothing
 * in a browser while still being tokens the model reads, so each one is a
 * place to spell a word a `grep` for it will not find:
 *
 * - U+200B–U+200F: zero-width space/joiners and the left-to-right marks.
 * - U+202A–U+202E: bidi embeddings and overrides.
 * - U+2060–U+206F: word joiner, invisible operators, bidi isolates.
 * - U+2063 is covered by that range; U+061C is the Arabic letter mark.
 * - U+FE00–U+FE0F: variation selectors, which change a neighbouring glyph
 *   rather than showing anything of their own.
 * - U+180E (Mongolian vowel separator) and U+00AD (soft hyphen).
 * - C0 and C1 controls, except the whitespace a body legitimately uses.
 * - U+E0000–U+E007F: the tag block, which renders as nothing and maps onto
 *   ASCII, so it can carry an entire instruction invisibly.
 * - U+E0100–U+E01EF: the variation selector supplement, the same glyph-modifying
 *   trick for characters outside the BMP.
 *
 * One list, two uses: prose has these removed, and a diff has them marked. The
 * two must never disagree, or one of the two paths becomes the way in.
 */
const INVISIBLE_SOURCE =
	"\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F" +
	"\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u206F\\uFE00-\\uFE0F\\uFEFF\\u061C\\u180E\\u00AD";
const INVISIBLE = new RegExp(`[${INVISIBLE_SOURCE}]|[\\u{E0000}-\\u{E007F}\\u{E0100}-\\u{E01EF}]`, "gu");

export function stripInvisibleCharacters(text: string): string {
	return text.replace(INVISIBLE, "");
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
 * Rewrite every HTML tag in `text` without a regex.
 *
 * The regex that expressed this (`<[a-zA-Z](?:[^>"']|"[^"]*"?|'[^']*'?)*>`)
 * backtracks exponentially: the optional closing quote makes every quoted span
 * ambiguous between "end at the quote" and "end at the tag's `>`", and a run
 * of quotes with no `>` in sight has 2^n parse paths — ~2 s at 40 quotes and
 * ~106 s at 48, on text a pull request controls. A scan with a quote flag has
 * one path.
 *
 * A quote only opens a span when the previous non-space character is `=`.
 * That is what makes `<span title="` start a quoted value while `<span
 * title=x"y>` does not, which is also how HTML5 tokenises a stray quote inside
 * an unquoted value: it belongs to the value. When a quoted span never closes,
 * the scan falls back to the first `>` so the tag is still rewritten instead of
 * being skipped.
 */
const MAX_TAG_CHARS = 4096;

function rewriteTags(text: string, rewrite: (tag: string) => string): string {
	let out = "";
	let index = 0;
	while (index < text.length) {
		const open = text.indexOf("<", index);
		if (open < 0) return out + text.slice(index);
		out += text.slice(index, open);
		if (!/[a-zA-Z]/.test(text[open + 1] ?? "")) {
			out += "<";
			index = open + 1;
			continue;
		}

		const limit = Math.min(text.length, open + MAX_TAG_CHARS);
		let end = scanTagEnd(text, open, limit);
		if (end === undefined) {
			// The quoted value did not close inside the cap. Fall back to the first
			// `>` anyway, even past the cap: skipping the tag instead would make a
			// long hidden value the one place sanitising does not reach.
			end = text.indexOf(">", open + 1);
		}
		if (end < 0) {
			// No `>` at all, so this is not a tag. Leave the rest alone.
			return out + text.slice(open);
		}
		out += rewrite(text.slice(open, end + 1));
		index = end + 1;
	}
	return out;
}

/** The index of the `>` that closes the tag, honouring quoted values. */
function scanTagEnd(text: string, open: number, limit: number): number | undefined {
	let quote: string | undefined;
	for (let index = open + 1; index < limit; index += 1) {
		const character = text[index];
		if (quote) {
			if (character === quote) quote = undefined;
			continue;
		}
		if (character === ">") return index;
		if (character === '"' || character === "'") {
			let previous = index - 1;
			while (previous > open && /\s/.test(text[previous] ?? "")) previous -= 1;
			if (text[previous] === "=") quote = character;
		}
	}
	return undefined;
}

/**
 * Attribute values on raw HTML in a body.
 *
 * Every attribute is invisible to a reader, and that includes its *name*: a
 * browser renders nothing for `<span IGNORE-ALL-PREVIOUS-INSTRUCTIONS>`, while
 * the model reads the name as text. `<div hidden>` is the same channel from the
 * other direction, where the presence of the attribute hides the content.
 *
 * So the tag is rebuilt rather than edited: the element name, the two
 * attributes whose value is text a reader can act on (`href` to follow, `src` to
 * name the image), and a self-closing slash. Everything else in the tag is
 * dropped, name and value together.
 */
export function stripHiddenAttributes(text: string): string {
	const KEPT = new Set(["href", "src"]);
	const attribute = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g;
	return rewriteTags(text, (tag) => {
		const name = /^<([a-zA-Z][a-zA-Z0-9:.-]*)/.exec(tag)?.[1];
		if (!name) return tag;
		const kept: string[] = [];
		for (const match of tag.matchAll(attribute)) {
			const attributeName = match[1] ?? "";
			if (KEPT.has(attributeName.toLowerCase())) kept.push(`${attributeName}=${match[2]}`);
		}
		const selfClosing = /\/\s*>$/.test(tag) ? " /" : "";
		return `<${name}${kept.map((pair) => ` ${pair}`).join("")}${selfClosing}>`;
	});
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
 * The diff is not stripped, because a zero-width character inside a diff may be
 * the finding: rewriting it away destroys the evidence the review exists to
 * find. Leaving it alone is not good enough either, though — it is as invisible
 * on GitHub as it is anywhere else, so a diff line ending in `//` plus a run of
 * them is an empty comment to a reader and a payload to the model.
 *
 * So it is marked instead: every invisible code point becomes `[U+200B]`, which
 * a reviewer can see, quote, and count. `target.diff` is untouched, and inline
 * anchors were always validated against it. The set is `INVISIBLE`, the same one
 * `stripInvisibleCharacters` uses, so a code point cannot be handled on one path
 * and forgotten on the other.
 */
export function markInvisibleCharacters(text: string): string {
	return text.replace(INVISIBLE, (character) => {
		const code = character.codePointAt(0) ?? 0;
		return `[U+${code.toString(16).toUpperCase().padStart(4, "0")}]`;
	});
}
