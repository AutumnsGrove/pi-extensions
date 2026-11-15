/**
 * Turn a model reply into the labels this run may actually write.
 *
 * The model proposes; this decides. Every claim is answered from the manifest
 * (does the label exist, may a machine assign that group, is the group already
 * spoken for) or from the tree (does the evidence hold). What survives is
 * applied; what does not is reported with a reason, because a rejection nobody
 * can see is how the old labeler disagreed with a human and said nothing.
 *
 * `@pi fix` is the same pipeline with one addition: labels the bot applied
 * before, or that the request names in backticks, stop counting against their
 * group's cap and become candidates for removal — but only when the model says
 * why. "It changed its mind" is not a reason.
 */

import { checkEvidence, describeEvidence, type Evidence, type EvidenceContext, parseEvidence } from "./evidence.ts";
import {
	type Group,
	type Label,
	type Manifest,
	HUMAN_GROUPS,
	capFor,
	labelByName,
	retiredNames,
} from "./manifest.ts";

/** A label this run will add. */
export interface Applied {
	name: string;
	group: Group;
	/** One line for the comment: the rule it cites, or the evidence checked. */
	why: string;
}

/** A label this run will take off, and why. */
export interface Removed {
	name: string;
	why: string;
}

/** A label the model claimed and the validator refused. */
export interface Rejected {
	name: string;
	reason: string;
}

/** A label the model considered and chose not to apply. */
export interface Considered {
	name: string;
	whyNot: string;
}

/** A label that could have been removed and was not, with the reason it stayed. */
export interface LeftInPlace {
	name: string;
	reason: string;
}

export interface Proposal {
	applied: Applied[];
	removed: Removed[];
	rejected: Rejected[];
	considered: Considered[];
	leftInPlace: LeftInPlace[];
}

export interface ProposalInput {
	/** Raw model output. Untrusted, possibly fenced, possibly chatty. */
	reply: string;
	manifest: Manifest;
	/** What the issue says now. */
	issue: { title: string; labels: string[] };
	evidence: EvidenceContext;
	/** Labels from the bot's own `applied` marker, if there is one. */
	previous?: string[];
	/** Set for an `@pi fix` run: the maintainer's note. */
	fix?: { note: string };
}

export class ProposalError extends Error {
	readonly excerpt: string;

	constructor(message: string, excerpt: string) {
		super(message);
		this.name = "ProposalError";
		this.excerpt = excerpt;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The first balanced JSON object in the text. Models fence their output and
 * sometimes say a sentence first; neither is a reason to fail the run.
 */
export function extractJson(reply: string): unknown {
	const text = reply.replace(/```[a-zA-Z]*/g, " ");
	const start = text.indexOf("{");
	if (start === -1) throw new ProposalError("the reply contains no JSON object", reply);

	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < text.length; index += 1) {
		const char = text[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{") depth += 1;
		else if (char === "}") {
			depth -= 1;
			if (depth === 0) {
				const candidate = text.slice(start, index + 1);
				try {
					return JSON.parse(candidate);
				} catch (error) {
					throw new ProposalError(
						`the reply's JSON is malformed: ${error instanceof Error ? error.message : String(error)}`,
						candidate
					);
				}
			}
		}
	}
	throw new ProposalError("the reply's JSON object is never closed", reply.slice(start));
}

interface Claim {
	name: string;
	rule: string;
	evidence: Evidence[];
}

function readClaims(value: unknown): Claim[] {
	if (!isRecord(value) || !Array.isArray(value.labels)) return [];
	const claims: Claim[] = [];
	for (const entry of value.labels) {
		if (typeof entry === "string") {
			claims.push({ name: entry.trim(), rule: "", evidence: [] });
			continue;
		}
		if (!isRecord(entry)) continue;
		const name = typeof entry.name === "string" ? entry.name.trim() : "";
		if (!name) continue;
		claims.push({
			name,
			rule: typeof entry.rule === "string" ? entry.rule.trim() : "",
			evidence: parseEvidence(entry.evidence),
		});
	}
	return claims;
}

function readConsidered(value: unknown): Considered[] {
	if (!isRecord(value) || !Array.isArray(value.considered)) return [];
	const considered: Considered[] = [];
	for (const entry of value.considered) {
		if (!isRecord(entry)) continue;
		const name = typeof entry.name === "string" ? entry.name.trim() : "";
		const whyNot = typeof entry.why_not === "string" ? entry.why_not.trim() : "";
		if (name) considered.push({ name, whyNot });
	}
	return considered;
}

/**
 * Labels the request names in backticks. Deliberately not bare words: the
 * vocabulary is full of ordinary English — `landing`, `plant`, `amber`,
 * `clearing` — and "the fonts also live in apps/landing" must not read as
 * "remove the landing label".
 */
export function namedLabels(request: string, manifest: Manifest): string[] {
	const names = new Set<string>();
	const pattern = /`([^`\n]+)`/g;
	for (const match of request.matchAll(pattern)) {
		const candidate = match[1]?.trim();
		if (candidate && labelByName(manifest, candidate)) names.add(candidate);
	}
	return [...names];
}

export function buildProposal(input: ProposalInput): Proposal {
	const { manifest, issue, evidence: context } = input;
	const parsed = extractJson(input.reply);
	const claims = readClaims(parsed);
	const considered = readConsidered(parsed);

	const autoGroups = new Set(manifest.policy.auto_groups);
	const retired = new Set(retiredNames(manifest));
	const onIssue = new Set(issue.labels);
	const named = input.fix ? new Set(namedLabels(input.fix.note, manifest)) : new Set<string>();
	const attributable = new Set([...(input.previous ?? []), ...named]);

	/**
	 * In a fix run, a label the bot can attribute to itself stops counting while
	 * the proposal is checked, so a component can be swapped. Without that, the
	 * cap would reject the replacement and there would be nothing to remove.
	 */
	const reclaimable = new Set<string>();
	if (input.fix) {
		for (const name of attributable) {
			const label = labelByName(manifest, name);
			if (label && autoGroups.has(label.group) && onIssue.has(name)) reclaimable.add(name);
		}
	}

	const taken = new Map<Group, string[]>();
	for (const name of issue.labels) {
		if (reclaimable.has(name)) continue;
		const label = labelByName(manifest, name);
		if (!label) continue;
		const current = taken.get(label.group) ?? [];
		if (!current.includes(name)) current.push(name);
		taken.set(label.group, current);
	}

	const applied: Applied[] = [];
	const rejected: Rejected[] = [];
	const claimed = new Set<string>();

	for (const claim of claims) {
		if (claimed.has(claim.name)) continue;
		claimed.add(claim.name);

		const label = labelByName(manifest, claim.name);
		if (!label) {
			rejected.push({
				name: claim.name,
				reason: retired.has(claim.name) ? "retired in the manifest" : "not in the manifest",
			});
			continue;
		}
		if (!autoGroups.has(label.group)) {
			rejected.push({
				name: claim.name,
				reason: HUMAN_GROUPS.includes(label.group)
					? `\`${label.group}\` is a human judgement`
					: `\`${label.group}\` is not assigned by a machine`,
			});
			continue;
		}

		const current = taken.get(label.group) ?? [];
		const cap = capFor(manifest, label.group);
		if (!current.includes(claim.name) && current.length >= cap) {
			rejected.push({ name: claim.name, reason: fullGroup(label.group, current, cap) });
			continue;
		}

		const verdict = checkEvidence(label, claim.evidence, context);
		if (!verdict.ok) {
			rejected.push({ name: claim.name, reason: verdict.reason ?? "evidence did not hold" });
			continue;
		}

		const why = label.group === "type" ? claim.rule : describeClaim(label, claim);
		if (label.group === "type" && !why) {
			rejected.push({ name: claim.name, reason: "no rule cited — quote the `when` line it matches" });
			continue;
		}
		if (onIssue.has(claim.name)) {
			// Already there: nothing to write, and calling it applied would be a lie.
			continue;
		}

		applied.push({ name: claim.name, group: label.group, why });
		taken.set(label.group, [...current, claim.name]);
	}

	const appliedNames = new Set(applied.map((entry) => entry.name));
	const removed: Removed[] = [];
	const leftInPlace: LeftInPlace[] = [];
	if (input.fix) {
		for (const name of reclaimable) {
			if (appliedNames.has(name)) continue;
			const explanation = considered.find((entry) => entry.name === name)?.whyNot;
			if (named.has(name)) {
				removed.push({ name, why: "named in the request" });
				continue;
			}
			if (!explanation) {
				leftInPlace.push({ name, reason: "nothing explained removing it" });
				continue;
			}
			removed.push({ name, why: explanation });
		}
	}

	return {
		applied,
		removed,
		rejected,
		considered,
		leftInPlace,
	};
}

function fullGroup(group: Group, current: string[], cap: number): string {
	if (cap === 1) {
		return `that group already has a label (${current.map((name) => `\`${name}\``).join(", ")})`;
	}
	return `\`${group}\` is full — ${current.length} of ${cap} (${current.map((name) => `\`${name}\``).join(", ")})`;
}

/** The one line the comment shows for a label that needed evidence. */
function describeClaim(label: Label, claim: Claim): string {
	const first = claim.evidence[0];
	const described = first ? describeEvidence(first) : "";
	if (label.group === "component" && claim.rule) {
		return described ? `${described} — ${claim.rule}` : claim.rule;
	}
	return described || claim.rule;
}
