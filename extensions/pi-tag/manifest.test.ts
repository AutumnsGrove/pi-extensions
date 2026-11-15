import { describe, expect, it } from "vitest";
import {
	MANIFEST_PATH,
	ManifestError,
	autoLabels,
	capFor,
	labelByName,
	parseManifest,
	pathPrefixes,
	retiredNames,
	validateManifest,
} from "./manifest.ts";

const GOOD = `
version: 1
policy:
  max_per_group:
    type: 1
    component: 1
    pattern: 1
    size: 2
  auto_groups: [type, component, pattern]
  component_needs_title_or_path: true
  unlabelled_ok: true
labels:
  - name: bug
    group: type
    description: Something is broken
    when: It worked before and now it does not.
  - name: lattice
    group: component
    description: Framework and shared engine
    path: libs/, workers/
    when: The change is in shared infrastructure.
  - name: pattern:prism
    group: pattern
    description: Theming engine
    doc: docs/patterns/prism-pattern.md
    when: The issue is about the look and its tokens.
  - name: priority-high
    group: priority
    description: Do this cycle
    when: It unblocks the next thing.
dormant:
  - name: ivy
    state: shelved
    note: Email. Code junk-drawered.
retired:
  - name: stale
    why: Never applied by anything.
`;

function problemsOf(source: string): string[] {
	try {
		parseManifest(source);
	} catch (error) {
		if (error instanceof ManifestError) return error.problems;
		throw error;
	}
	throw new Error("expected the manifest to be rejected");
}

describe("parseManifest", () => {
	it("reads the vocabulary, the policy, and the graves", () => {
		const manifest = parseManifest(GOOD);
		expect(manifest.labels).toHaveLength(4);
		expect(manifest.policy.auto_groups).toEqual(["type", "component", "pattern"]);
		expect(manifest.policy.unlabelled_ok).toBe(true);
		expect(retiredNames(manifest)).toEqual(["ivy", "stale"]);
	});

	it("exposes only the labels a machine may choose", () => {
		const manifest = parseManifest(GOOD);
		expect(autoLabels(manifest).map((label) => label.name)).toEqual(["bug", "lattice", "pattern:prism"]);
		expect(labelByName(manifest, "priority-high")?.group).toBe("priority");
	});

	it("keeps the declared cap per group", () => {
		const manifest = parseManifest(GOOD);
		expect(capFor(manifest, "component")).toBe(1);
		expect(capFor(manifest, "size")).toBe(2);
	});

	it("points at the manifest the target repository ships", () => {
		expect(MANIFEST_PATH).toBe(".github/labels.yml");
	});
});

describe("pathPrefixes", () => {
	it("splits on commas and strips the trailing slash", () => {
		const manifest = parseManifest(GOOD);
		const lattice = labelByName(manifest, "lattice");
		expect(lattice && pathPrefixes(lattice)).toEqual(["libs", "workers"]);
	});

	it("tolerates spaces, ./ and repeated slashes", () => {
		const manifest = validateManifest(
			base([{ name: "x", group: "component", description: "d", when: "w", path: " ./a/ , b//, ,c " }])
		);
		const label = labelByName(manifest, "x");
		expect(label && pathPrefixes(label)).toEqual(["a", "b", "c"]);
	});

	it("returns nothing for a label without a path", () => {
		const manifest = parseManifest(GOOD);
		const bug = labelByName(manifest, "bug");
		expect(bug && pathPrefixes(bug)).toEqual([]);
	});
});

function base(extra: unknown[]) {
	return {
		version: 1,
		policy: { max_per_group: { type: 1, component: 1 }, auto_groups: ["type", "component"] },
		labels: [{ name: "bug", group: "type", description: "d", when: "w" }, ...extra],
	};
}

describe("validateManifest", () => {
	it("rejects a manifest that is not a mapping", () => {
		expect(problemsOf("- just\n- a list\n")).toEqual(["the file is not a YAML mapping"]);
	});

	it("rejects invalid YAML", () => {
		expect(problemsOf("labels: [oops\n").join(" ")).toContain("not valid YAML");
	});

	it("requires a policy rather than guessing one", () => {
		const problems = problemsOf(`
version: 1
labels:
  - name: bug
    group: type
    description: d
    when: w
`);
		expect(problems.join("\n")).toContain("policy: missing");
	});

	it("requires a cap for every group it may assign", () => {
		const problems = problemsOf(`
version: 1
policy:
  max_per_group: { type: 1 }
  auto_groups: [type, component]
labels:
  - name: bug
    group: type
    description: d
    when: w
  - name: lattice
    group: component
    description: d
    when: w
    path: libs/
`);
		expect(problems).toContain("policy.max_per_group.component: missing — every auto_group needs a cap");
	});

	it("refuses to let a machine assign a human judgement", () => {
		const problems = problemsOf(`
version: 1
policy:
  max_per_group: { priority: 1, type: 1 }
  auto_groups: [priority, type]
labels:
  - name: bug
    group: type
    description: d
    when: w
  - name: priority-high
    group: priority
    description: d
    when: w
`);
		expect(problems.join("\n")).toContain('policy.auto_groups: "priority" is a human judgement');
	});

	it("requires a path on a component and a doc on a pattern", () => {
		const problems = problemsOf(`
version: 1
policy:
  max_per_group: { component: 1, pattern: 1 }
  auto_groups: [component, pattern]
labels:
  - name: lattice
    group: component
    description: d
    when: w
  - name: pattern:prism
    group: pattern
    description: d
    when: w
`);
		expect(problems.join("\n")).toContain('a component needs a "path"');
		expect(problems.join("\n")).toContain('a pattern needs a "doc"');
	});

	it("reports every problem at once, and names the label", () => {
		const problems = problemsOf(`version: 1
policy:
  max_per_group: { type: 1 }
  auto_groups: [type]
labels:
  - name: bug
    group: type
  - name: bug
    group: type
    description: d
    when: w
  - name: broken
    group: nonsense
    description: d
    when: w
`);
		expect(problems.join("\n")).toContain('labels[0] (bug): needs a description');
		expect(problems.join("\n")).toContain('labels[0] (bug): needs a "when" rule');
		expect(problems.join("\n")).toContain('"bug" is declared 2 times');
		expect(problems.join("\n")).toContain('group "nonsense" is not one of');
	});

	it("refuses to argue with itself about a buried label", () => {
		const problems = problemsOf(`
version: 1
policy:
  max_per_group: { type: 1 }
  auto_groups: [type]
labels:
  - name: ivy
    group: type
    description: d
    when: w
dormant:
  - name: ivy
    state: shelved
    note: gone
`);
		expect(problems).toContain('"ivy" is both active and dormant/retired');
	});

	it("accepts a manifest that says nothing about dormant or retired labels", () => {
		const manifest = validateManifest(
			base([{ name: "lattice", group: "component", description: "d", when: "w", path: "libs/" }])
		);
		expect(manifest.dormant).toEqual([]);
		expect(manifest.retired).toEqual([]);
		expect(manifest.policy.component_needs_title_or_path).toBe(true);
	});
});
