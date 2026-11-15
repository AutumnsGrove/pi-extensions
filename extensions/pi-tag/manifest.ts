/**
 * Read and validate a repository's label manifest.
 *
 * The manifest is the vocabulary, the policy, and the evidence at once: a
 * label's `when` line is the rule, a component's `path` is the only proof that
 * it applies, and a pattern's `doc` is the document that settles it. The
 * workflow pi-tag replaces reads this file twice — `awk` for name→group, `cat`
 * for the whole thing into the prompt — and checks neither.
 *
 * Shape mirrors the validator the target repository already ships
 * (`tools/labels/sync.ts`), so a manifest that fails there fails here for the
 * same reasons. Colour is deliberately not checked: pi-tag never writes one.
 *
 * This module is pure. It parses text and validates what pi-tag actually uses;
 * whether a `doc:` file exists is a question for `evidence.ts`, which has the
 * checkout.
 */

import { readFileSync } from "node:fs";
import { parse } from "yaml";

/** Where the vocabulary lives in the target repository. */
export const MANIFEST_PATH = ".github/labels.yml";

export const GROUPS = [
	"type",
	"concern",
	"component",
	"pattern",
	"size",
	"priority",
	"readiness",
	"machine",
] as const;

export type Group = (typeof GROUPS)[number];

/** Groups a machine may never assign, whatever the manifest asks for. */
export const HUMAN_GROUPS: readonly Group[] = ["priority", "readiness", "size", "machine", "concern"];

export interface Label {
	name: string;
	group: Group;
	description: string;
	/** The rule. The name of a label is never evidence for itself. */
	when: string;
	/** Comma-separated path prefixes. Required for components, ignored otherwise. */
	path?: string;
	/** The document that settles whether a pattern applies. Required for patterns. */
	doc?: string;
}

export interface Policy {
	/** Upper bound per group. Every `auto_groups` entry must have one. */
	max_per_group: Partial<Record<Group, number>>;
	/** The only groups a machine may choose from. */
	auto_groups: Group[];
	component_needs_title_or_path: boolean;
	unlabelled_ok: boolean;
}

export interface DormantLabel {
	name: string;
	state: string;
	note: string;
}

export interface RetiredLabel {
	name: string;
	why: string;
}

export interface Manifest {
	version: number;
	policy: Policy;
	labels: Label[];
	dormant: DormantLabel[];
	retired: RetiredLabel[];
}

export class ManifestError extends Error {
	constructor(readonly problems: string[]) {
		super(
			`labels.yml has ${problems.length} problem${problems.length === 1 ? "" : "s"}:\n` +
				problems.map((p) => `  • ${p}`).join("\n")
		);
		this.name = "ManifestError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Collect every problem and report them together, not one per run. */
export function validateManifest(value: unknown): Manifest {
	if (!isRecord(value)) throw new ManifestError(["the file is not a YAML mapping"]);

	const problems: string[] = [];
	if (value.version !== 1) problems.push(`version: expected 1, got ${String(value.version)}`);

	const rawLabels = value.labels;
	if (!Array.isArray(rawLabels) || rawLabels.length === 0) {
		problems.push("labels: expected a non-empty list");
	}

	const labels: Label[] = [];
	const seen = new Map<string, number>();
	const declaredGroups = new Set<Group>();

	for (const [index, entry] of (Array.isArray(rawLabels) ? rawLabels : []).entries()) {
		if (!isRecord(entry)) {
			problems.push(`labels[${index}]: expected a mapping`);
			continue;
		}
		const name = text(entry.name);
		if (!name) {
			problems.push(`labels[${index}]: missing name`);
			continue;
		}
		const at = `labels[${index}] (${name})`;
		seen.set(name, (seen.get(name) ?? 0) + 1);

		const group = entry.group;
		if (!GROUPS.includes(group as Group)) {
			problems.push(`${at}: group "${String(group)}" is not one of ${GROUPS.join(", ")}`);
			continue;
		}
		declaredGroups.add(group as Group);

		const description = text(entry.description);
		if (!description) problems.push(`${at}: needs a description`);

		const when = text(entry.when);
		if (!when) problems.push(`${at}: needs a "when" rule — that is the whole point of this file`);

		const path = text(entry.path);
		if (group === "component" && !path) {
			problems.push(`${at}: a component needs a "path" so the label can be verified`);
		}

		const doc = text(entry.doc);
		if (group === "pattern" && !doc) {
			problems.push(`${at}: a pattern needs a "doc" — the document decides whether it applies`);
		}

		labels.push({ name, group: group as Group, description: description ?? "", when: when ?? "", path, doc });
	}

	for (const [name, count] of seen) {
		if (count > 1) problems.push(`"${name}" is declared ${count} times`);
	}

	const dormant = list(value.dormant, "dormant", ["state", "note"], problems).map((entry) => ({
		name: entry.name,
		state: entry.fields.state ?? "",
		note: entry.fields.note ?? "",
	}));
	const retired = list(value.retired, "retired", ["why"], problems).map((entry) => ({
		name: entry.name,
		why: entry.fields.why ?? "",
	}));

	// The manifest must not argue with itself about what is alive.
	for (const entry of [...dormant, ...retired]) {
		if (labels.some((label) => label.name === entry.name)) {
			problems.push(`"${entry.name}" is both active and dormant/retired`);
		}
	}

	const policy = readPolicy(value.policy, declaredGroups, problems);

	if (problems.length > 0) throw new ManifestError(problems);

	return { version: 1, policy, labels, dormant, retired };
}

function list(
	value: unknown,
	field: string,
	required: readonly string[],
	problems: string[]
): { name: string; fields: Record<string, string> }[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		problems.push(`${field}: expected a list`);
		return [];
	}
	const entries: { name: string; fields: Record<string, string> }[] = [];
	for (const [index, entry] of value.entries()) {
		if (!isRecord(entry)) {
			problems.push(`${field}[${index}]: expected a mapping`);
			continue;
		}
		const name = text(entry.name);
		if (!name) {
			problems.push(`${field}[${index}]: missing name`);
			continue;
		}
		const fields: Record<string, string> = {};
		for (const key of required) {
			const found = text(entry[key]);
			if (!found) problems.push(`${field}[${index}] (${name}): needs a "${key}"`);
			else fields[key] = found;
		}
		entries.push({ name, fields });
	}
	return entries;
}

function readPolicy(value: unknown, declaredGroups: Set<Group>, problems: string[]): Policy {
	if (!isRecord(value)) {
		throw new ManifestError([
			"policy: missing — pi-tag will not guess which groups it may assign or how many",
			...problems,
		]);
	}

	const autoGroups: Group[] = [];
	const rawAuto = value.auto_groups;
	if (!Array.isArray(rawAuto) || rawAuto.length === 0) {
		problems.push("policy.auto_groups: expected a non-empty list — it is what a machine may choose");
	}
	for (const entry of Array.isArray(rawAuto) ? rawAuto : []) {
		if (!GROUPS.includes(entry as Group)) {
			problems.push(`policy.auto_groups: "${String(entry)}" is not a group`);
			continue;
		}
		if (HUMAN_GROUPS.includes(entry as Group)) {
			problems.push(`policy.auto_groups: "${String(entry)}" is a human judgement — a machine must not guess it`);
			continue;
		}
		if (!declaredGroups.has(entry as Group)) {
			problems.push(`policy.auto_groups: "${String(entry)}" has no labels`);
			continue;
		}
		autoGroups.push(entry as Group);
	}

	const maxPerGroup: Partial<Record<Group, number>> = {};
	const rawCaps = value.max_per_group;
	if (rawCaps !== undefined && !isRecord(rawCaps)) problems.push("policy.max_per_group: expected a mapping");
	for (const [group, cap] of Object.entries(isRecord(rawCaps) ? rawCaps : {})) {
		if (!GROUPS.includes(group as Group)) {
			problems.push(`policy.max_per_group: "${group}" is not a group`);
			continue;
		}
		if (typeof cap !== "number" || !Number.isInteger(cap) || cap < 1) {
			problems.push(`policy.max_per_group.${group}: expected a positive integer, got ${String(cap)}`);
			continue;
		}
		maxPerGroup[group as Group] = cap;
	}

	// No guessing: a cap for every group it may use, or the manifest is not
	// saying what it means.
	for (const group of autoGroups) {
		if (maxPerGroup[group] === undefined) {
			problems.push(`policy.max_per_group.${group}: missing — every auto_group needs a cap`);
		}
	}

	return {
		max_per_group: maxPerGroup,
		auto_groups: autoGroups,
		component_needs_title_or_path: value.component_needs_title_or_path !== false,
		unlabelled_ok: value.unlabelled_ok !== false,
	};
}

export function parseManifest(source: string): Manifest {
	let parsed: unknown;
	try {
		parsed = parse(source);
	} catch (error) {
		throw new ManifestError([
			`not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
		]);
	}
	return validateManifest(parsed);
}

export function readManifest(file: string): Manifest {
	let source: string;
	try {
		source = readFileSync(file, "utf8");
	} catch (error) {
		throw new ManifestError([
			`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
		]);
	}
	return parseManifest(source);
}

/** Labels a machine may choose, in manifest order. */
export function autoLabels(manifest: Manifest): Label[] {
	const groups = new Set(manifest.policy.auto_groups);
	return manifest.labels.filter((label) => groups.has(label.group));
}

export function labelByName(manifest: Manifest, name: string): Label | undefined {
	return manifest.labels.find((label) => label.name === name);
}

/** Names the manifest says must never be applied again. */
export function retiredNames(manifest: Manifest): string[] {
	return [...manifest.dormant, ...manifest.retired].map((entry) => entry.name);
}

export function capFor(manifest: Manifest, group: Group): number {
	// Validated above, so a missing cap is a manifest we refused to load.
	return manifest.policy.max_per_group[group] ?? 0;
}

/**
 * `libs/, workers/` → `["libs", "workers"]`. A trailing slash is stripped and
 * `./` is dropped so a prefix compares as a directory, not a string: `libs`
 * matches `libs/engine/x.ts` and never `libs2/x.ts`.
 */
export function pathPrefixes(label: Label): string[] {
	if (!label.path) return [];
	return label.path
		.split(",")
		.map((part) => part.trim().replace(/^\.\//, "").replace(/\/+$/, ""))
		.filter(Boolean);
}
