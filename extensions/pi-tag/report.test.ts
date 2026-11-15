import { describe, expect, it } from "vitest";
import { formatReport, jsonReport } from "./report.ts";
import type { Proposal } from "./proposal.ts";
import type { Issue } from "./github.ts";

const issue: Issue = {
	number: 1657,
	title: "Shutter: promote the TypeScript port to a library",
	body: "",
	labels: ["tech-debt", "pattern:songbird"],
	state: "OPEN",
	url: "https://github.com/o/r/issues/1657",
};

const empty: Proposal = { applied: [], removed: [], rejected: [], considered: [], leftInPlace: [] };

describe("formatReport", () => {
	it("leads with the issue and what it already carries", () => {
		const text = formatReport(issue, empty);
		expect(text.split("\n")[0]).toBe("#1657  Shutter: promote the TypeScript port to a library");
		expect(text).toContain("labels now: tech-debt, pattern:songbird");
	});

	it("says plainly when nothing was applied", () => {
		expect(formatReport(issue, empty)).toContain("+ nothing applied");
	});

	it("shows each applied label with its reason, aligned", () => {
		const text = formatReport(issue, {
			...empty,
			applied: [
				{ name: "bug", group: "type", why: "It worked before and now it does not." },
				{ name: "lattice", group: "component", why: "read `libs/shutter/src/index.ts`" },
			],
		});
		expect(text).toContain("+ bug      It worked before and now it does not.");
		expect(text).toContain("+ lattice  read `libs/shutter/src/index.ts`");
	});

	it("marks removals with a minus", () => {
		const text = formatReport(issue, {
			...empty,
			removed: [{ name: "clearing", why: "the files are under libs/shutter" }],
		});
		expect(text).toContain("- clearing  the files are under libs/shutter");
	});

	it("separates refusals from the applied list", () => {
		const text = formatReport(issue, {
			...empty,
			applied: [{ name: "bug", group: "type", why: "broken" }],
			rejected: [{ name: "ivy", reason: "retired in the manifest" }],
			leftInPlace: [{ name: "landing", reason: "nothing explained removing it" }],
		});
		expect(text).toContain("x ivy  retired in the manifest");
		expect(text).toContain("= landing  left in place: nothing explained removing it");
		expect(text.indexOf("+ bug")).toBeLessThan(text.indexOf("x ivy"));
	});

	it("lists what was considered, but only when a reason was given", () => {
		const text = formatReport(issue, {
			...empty,
			considered: [
				{ name: "clearing", whyNot: "the work is in libs/shutter" },
				{ name: "amber", whyNot: "" },
			],
		});
		expect(text).toContain("· clearing  the work is in libs/shutter");
		expect(text).not.toContain("amber");
	});
});

describe("jsonReport", () => {
	it("carries the issue and the whole proposal", () => {
		const report = jsonReport(issue, { ...empty, applied: [{ name: "bug", group: "type", why: "w" }] }, "body");
		expect(report.issue.number).toBe(1657);
		expect(report.issue.url).toBe("https://github.com/o/r/issues/1657");
		expect(report.proposal.applied).toHaveLength(1);
		expect(report.comment).toBe("body");
	});
});
