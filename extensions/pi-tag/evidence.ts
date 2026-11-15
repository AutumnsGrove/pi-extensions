/**
 * The evidence rules.
 *
 * A label is not a mood; it is a claim about this repository. `type` is a claim
 * about the issue text, so the rule it cites is the evidence. `component` and
 * `pattern` are claims about the code, and they are the ones the old labeler got
 * wrong because it could not look: it named products from titles and guessed at
 * patterns from prose.
 *
 * Here each claim has to arrive with proof that the caller can check:
 *
 *   title — the phrase appears in the title
 *   path  — a real path in the tree, under one of the label's `path:` prefixes
 *   doc   — the label's own `doc:`, which exists
 *
 * The evidence is only ever checked against the tree and the title, never
 * against prose the model wrote, so a wrong proposal is dropped with a reason
 * instead of applied with confidence.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Label, pathPrefixes } from "./manifest.ts";

export type EvidenceKind = "title" | "path" | "doc";

export type Evidence =
	| { kind: "title"; phrase: string }
	| { kind: "path"; path: string }
	| { kind: "doc"; path: string };

export interface EvidenceContext {
	/** The issue title, exactly as stored. */
	title: string;
	/** Whether a repo-relative path exists in the checkout. */
	exists(path: string): boolean;
}

export interface Verdict {
	ok: boolean;
	reason?: string;
}

const OK: Verdict = { ok: true };

function reject(reason: string): Verdict {
	return { ok: false, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Turn untrusted JSON into evidence we are willing to check. Unknown kinds are
 * dropped rather than trusted, and so is a path containing `..` — it would match
 * no prefix anyway, but it should never reach a log or a comment as a claim.
 */
export function parseEvidence(value: unknown): Evidence[] {
	if (!Array.isArray(value)) return [];
	const evidence: Evidence[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		const kind = entry.kind;
		if (kind === "title") {
			const phrase = typeof entry.phrase === "string" ? entry.phrase.trim() : "";
			if (phrase) evidence.push({ kind: "title", phrase });
			continue;
		}
		if (kind === "path" || kind === "doc") {
			const path = normalisePath(entry.path);
			if (path) evidence.push({ kind, path });
		}
	}
	return evidence;
}

/** `./libs/x.ts`, `/libs/x.ts`, `libs/x.ts` all say the same thing. */
export function normalisePath(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
	if (!trimmed) return undefined;
	const segments = trimmed.split("/");
	if (segments.some((segment) => segment === ".." || segment === ".")) return undefined;
	return segments.filter(Boolean).join("/");
}

/** Is `path` the prefix, or inside it? `libs` matches `libs/x` and never `libs2/x`. */
export function underPrefix(path: string, prefixes: string[]): string | undefined {
	for (const prefix of prefixes) {
		if (path === prefix || path.startsWith(`${prefix}/`)) return prefix;
	}
	return undefined;
}

/**
 * Whole-word, case-insensitive, unicode-aware. `Clearing` matches "Clearing:
 * stop the status page" and never "clearinghouse".
 */
export function phraseInTitle(title: string, phrase: string): boolean {
	const escaped = phrase.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	if (!escaped) return false;
	return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(title);
}

/**
 * Why a component or pattern needs what it needs. `type` labels are claims about
 * the issue, so the `when` rule they cite is the evidence and nothing else is
 * required — that is the one group the old labeler was already good at.
 */
export function checkEvidence(label: Label, evidence: Evidence[], context: EvidenceContext): Verdict {
	if (label.group === "type") return OK;

	const prefixes = pathPrefixes(label);

	if (label.group === "component") {
		const proven = evidence.filter((entry) => entry.kind === "title" || entry.kind === "path");
		if (proven.length === 0) {
			return reject("no evidence: a component needs the title to name it or a path it can point at");
		}
		// One good piece of evidence is enough; the first failure is only worth
		// reporting when nothing worked, so a stray bad guess cannot sink a claim
		// that also happens to be proven.
		let failure = "";
		for (const entry of proven) {
			const problem =
				entry.kind === "title"
					? phraseInTitle(context.title, entry.phrase)
						? undefined
						: `the title does not contain "${entry.phrase}"`
					: checkPath(entry.path, prefixes, context);
			if (!problem) return OK;
			if (!failure) failure = problem;
		}
		return reject(failure);
	}

	if (label.group === "pattern") {
		const docs = evidence.filter((entry) => entry.kind === "doc");
		if (docs.length === 0) {
			return reject(`no evidence: a pattern needs its doc read (${label.doc ?? "none declared"})`);
		}
		let failure = "";
		for (const entry of docs) {
			if (entry.kind !== "doc") continue;
			if (!label.doc) return reject(`"${label.name}" declares no doc to read`);
			if (normalisePath(entry.path) !== normalisePath(label.doc)) {
				failure ||= `"${entry.path}" is not that pattern's doc (${label.doc})`;
				continue;
			}
			if (!context.exists(entry.path)) {
				failure ||= `"${entry.path}" is not in the tree`;
				continue;
			}
			return OK;
		}
		return reject(failure);
	}

	return reject(`${label.group} labels are not assigned by a machine`);
}

function checkPath(path: string, prefixes: string[], context: EvidenceContext): string | undefined {
	if (!context.exists(path)) return `"${path}" is not in the tree`;
	const prefix = underPrefix(path, prefixes);
	if (prefix === undefined) {
		return `"${path}" is not under ${labelPaths(prefixes)}`;
	}
	return undefined;
}

function labelPaths(prefixes: string[]): string {
	if (prefixes.length === 0) return "any declared path";
	return prefixes.map((prefix) => `\`${prefix}/\``).join(" or ");
}

/** One phrase for the comment, so the reader can see what was checked. */
export function describeEvidence(evidence: Evidence): string {
	switch (evidence.kind) {
		case "title":
			return `the title names \`${evidence.phrase}\``;
		case "path":
			return `read \`${evidence.path}\``;
		case "doc":
			return `read \`${evidence.path}\``;
	}
}

/** A file-existence check rooted at a checkout. */
export function treeAt(root: string): EvidenceContext["exists"] {
	const base = resolve(root);
	return (path: string) => {
		const full = resolve(join(base, path));
		// A path that escapes the checkout is not evidence of anything.
		if (full !== base && !full.startsWith(`${base}/`)) return false;
		return existsSync(full);
	};
}
