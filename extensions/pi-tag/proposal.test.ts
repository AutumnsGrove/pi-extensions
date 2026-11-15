import { describe, expect, it } from "vitest";
import { ProposalError, buildProposal, extractJson, namedLabels } from "./proposal.ts";
import { parseManifest } from "./manifest.ts";

const MANIFEST = `
version: 1
policy:
  max_per_group:
    type: 1
    component: 1
    pattern: 1
  auto_groups: [type, component, pattern]
  component_needs_title_or_path: true
  unlabelled_ok: true
labels:
  - name: bug
    group: type
    description: Broken
    when: It worked before and now it does not.
  - name: tech-debt
    group: type
    description: Owed
    when: Nothing new ships.
  - name: lattice
    group: component
    description: Engine
    path: libs/, workers/
    when: Shared infrastructure.
  - name: clearing
    group: component
    description: Status page
    path: apps/clearing/
    when: What we tell people when something is down.
  - name: aspen
    group: component
    description: Tenant sites
    path: apps/aspen/
    when: A tenant can see the difference.
  - name: priority-high
    group: priority
    description: Do it now
    when: It unblocks the next thing.
  - name: pattern:songbird
    group: pattern
    description: Injection defence
    doc: docs/patterns/songbird-pattern.md
    when: Untrusted input reaching a model.
dormant:
  - name: ivy
    state: shelved
    note: Email.
retired:
  - name: stale
    why: Never applied.
`;

const manifest = parseManifest(MANIFEST);

const TREE = new Set([
	"libs/shutter/src/index.ts",
	"apps/clearing/src/routes/status.ts",
	"docs/patterns/songbird-pattern.md",
	"docs/patterns/prism-pattern.md",
]);

const evidence = { title: "Clearing: stop the status page lying", exists: (p: string) => TREE.has(p) };

function propose(reply: unknown, overrides: Partial<Parameters<typeof buildProposal>[0]> = {}) {
	return buildProposal({
		reply: typeof reply === "string" ? reply : JSON.stringify(reply),
		manifest,
		issue: { title: evidence.title, labels: [] },
		evidence,
		...overrides,
	});
}

describe("extractJson", () => {
	it("reads a bare object", () => {
		expect(extractJson('{"a":1}')).toEqual({ a: 1 });
	});

	it("reads through a fence and a sentence", () => {
		expect(extractJson('Here you go:\n```json\n{"a":{"b":2}}\n```\nDone.')).toEqual({ a: { b: 2 } });
	});

	it("is not fooled by braces inside strings", () => {
		expect(extractJson('{"a":"}{\\""}')).toEqual({ a: '}{"' });
	});

	it("says why when there is no object", () => {
		expect(() => extractJson("no json here")).toThrow(ProposalError);
		expect(() => extractJson('{"a":1')).toThrow(/never closed/);
		expect(() => extractJson('{"a":}')).toThrow(/malformed/);
	});
});

describe("namedLabels", () => {
	it("reads only backticked label names", () => {
		expect(namedLabels("remove `amber` and `clearing` please", manifest)).toEqual(["clearing"]);
	});

	it("ignores prose that happens to contain a product name", () => {
		expect(namedLabels("the fonts also live in apps/landing", manifest)).toEqual([]);
	});
});

describe("buildProposal", () => {
	it("applies a type label that cites its rule", () => {
		const result = propose({
			labels: [{ name: "bug", rule: "It worked before and now it does not: outages invented." }],
		});
		expect(result.applied).toEqual([
			{
				name: "bug",
				group: "type",
				why: "It worked before and now it does not: outages invented.",
			},
		]);
		expect(result.rejected).toEqual([]);
	});

	it("drops a type label that cites no rule", () => {
		const result = propose({ labels: [{ name: "bug" }] });
		expect(result.applied).toEqual([]);
		expect(result.rejected[0]?.reason).toContain("no rule cited");
	});

	it("applies a component proven by a path", () => {
		const result = propose({
			labels: [
				{ name: "tech-debt", rule: "Nothing new ships." },
				{ name: "lattice", evidence: [{ kind: "path", path: "libs/shutter/src/index.ts" }] },
			],
		});
		expect(result.applied.map((entry) => entry.name)).toEqual(["tech-debt", "lattice"]);
		expect(result.applied[1]?.why).toBe("read `libs/shutter/src/index.ts`");
	});

	it("drops a component with no evidence — the #1657 case", () => {
		const result = propose({ labels: [{ name: "lattice" }] });
		expect(result.rejected[0]).toEqual({
			name: "lattice",
			reason: "no evidence: a component needs the title to name it or a path it can point at",
		});
	});

	it("drops a component the issue already has, and says who has the group", () => {
		const result = propose(
			{ labels: [{ name: "lattice", evidence: [{ kind: "path", path: "libs/shutter/src/index.ts" }] }] },
			{ issue: { title: evidence.title, labels: ["clearing"] } }
		);
		expect(result.applied).toEqual([]);
		expect(result.rejected[0]?.reason).toBe("that group already has a label (`clearing`)");
	});

	it("says so when a group is already over its cap", () => {
		// The old labeler left #1628 with two components. Nothing may be added to
		// that group now, and the reason should say why rather than repeat itself.
		const result = propose(
			{ labels: [{ name: "lattice", evidence: [{ kind: "path", path: "libs/shutter/src/index.ts" }] }] },
			{ issue: { title: evidence.title, labels: ["clearing", "aspen"] } }
		);
		expect(result.applied).toEqual([]);
		expect(result.rejected[0]?.reason).toBe("`component` is already over its cap of 1 (`clearing`, `aspen`)");
	});

	it("applies only one of two components and reports the other", () => {
		const result = propose({
			labels: [
				{ name: "lattice", evidence: [{ kind: "path", path: "libs/shutter/src/index.ts" }] },
				{ name: "clearing", evidence: [{ kind: "title", phrase: "Clearing" }] },
			],
		});
		expect(result.applied.map((entry) => entry.name)).toEqual(["lattice"]);
		expect(result.rejected).toEqual([
			{ name: "clearing", reason: "that group already has a label (`lattice`)" },
		]);
	});

	it("drops a label that is not in the manifest, and one that is buried", () => {
		const result = propose({ labels: [{ name: "ivy" }, { name: "stale" }, { name: "nonsense" }] });
		expect(result.rejected).toEqual([
			{ name: "ivy", reason: "retired in the manifest" },
			{ name: "stale", reason: "retired in the manifest" },
			{ name: "nonsense", reason: "not in the manifest" },
		]);
	});

	it("refuses a group a human decides", () => {
		const result = propose({ labels: [{ name: "priority-high" }] });
		expect(result.rejected[0]?.reason).toBe("`priority` is a human judgement");
	});

	it("does not call a label already on the issue applied", () => {
		const result = propose(
			{ labels: [{ name: "bug", rule: "It worked before." }] },
			{ issue: { title: evidence.title, labels: ["bug"] } }
		);
		expect(result.applied).toEqual([]);
		expect(result.rejected).toEqual([]);
	});

	it("requires a pattern's own doc", () => {
		const wrong = propose({
			labels: [{ name: "pattern:songbird", evidence: [{ kind: "doc", path: "docs/patterns/prism-pattern.md" }] }],
		});
		expect(wrong.rejected[0]?.reason).toContain("not that pattern's doc");

		const right = propose({
			labels: [{ name: "pattern:songbird", evidence: [{ kind: "doc", path: "docs/patterns/songbird-pattern.md" }] }],
		});
		expect(right.applied.map((entry) => entry.name)).toEqual(["pattern:songbird"]);
	});

	it("reports what the model considered and set aside", () => {
		const result = propose({
			labels: [{ name: "bug", rule: "It worked before." }],
			considered: [{ name: "clearing", why_not: "the work is in libs/shutter" }],
		});
		expect(result.considered).toEqual([{ name: "clearing", whyNot: "the work is in libs/shutter" }]);
	});
});

describe("buildProposal on an @pi fix run", () => {
	const issue = { title: evidence.title, labels: ["bug", "clearing", "size/S"] };

	it("swaps a component it applied before for one the evidence now supports", () => {
		const result = propose(
			{
				labels: [
					{ name: "bug", rule: "It worked before." },
					{ name: "lattice", evidence: [{ kind: "path", path: "libs/shutter/src/index.ts" }] },
				],
				considered: [{ name: "clearing", why_not: "the files are under libs/shutter, not apps/clearing" }],
			},
			{ issue, previous: ["clearing"], fix: { note: "the fonts also live in `libs`" } }
		);
		expect(result.applied.map((entry) => entry.name)).toEqual(["lattice"]);
		expect(result.removed).toEqual([
			{ name: "clearing", why: "the files are under libs/shutter, not apps/clearing" },
		]);
	});

	it("leaves a label alone when nothing explains removing it", () => {
		const result = propose(
			{ labels: [{ name: "lattice", evidence: [{ kind: "path", path: "libs/shutter/src/index.ts" }] }] },
			{ issue, previous: ["clearing"], fix: { note: "something" } }
		);
		expect(result.removed).toEqual([]);
		expect(result.leftInPlace).toEqual([{ name: "clearing", reason: "nothing explained removing it" }]);
	});

	it("removes a label the request names, without needing an explanation", () => {
		const result = propose(
			{ labels: [{ name: "lattice", evidence: [{ kind: "path", path: "libs/shutter/src/index.ts" }] }] },
			{ issue, previous: ["clearing"], fix: { note: "`clearing` is wrong here" } }
		);
		expect(result.removed).toEqual([{ name: "clearing", why: "named in the request" }]);
	});

	it("never removes a human's label, even when asked", () => {
		const result = propose(
			{ labels: [{ name: "lattice", evidence: [{ kind: "path", path: "libs/shutter/src/index.ts" }] }] },
			{ issue, previous: ["clearing", "size/S"], fix: { note: "drop `size/S` and `clearing`" } }
		);
		expect(result.removed.map((entry) => entry.name)).toEqual(["clearing"]);
	});

	it("never removes a label that is not on the issue", () => {
		const result = propose(
			{ labels: [{ name: "lattice", evidence: [{ kind: "path", path: "libs/shutter/src/index.ts" }] }] },
			{ issue: { title: evidence.title, labels: [] }, previous: ["clearing"], fix: { note: "`clearing`" } }
		);
		expect(result.removed).toEqual([]);
	});

	it("keeps a label it re-applies", () => {
		const result = propose(
			{
				labels: [
					{ name: "clearing", evidence: [{ kind: "title", phrase: "Clearing" }] },
					{ name: "pattern:songbird", evidence: [{ kind: "doc", path: "docs/patterns/songbird-pattern.md" }] },
				],
			},
			{ issue, previous: ["clearing"], fix: { note: "add songbird" } }
		);
		expect(result.removed).toEqual([]);
		expect(result.applied.map((entry) => entry.name)).toEqual(["pattern:songbird"]);
	});
});
