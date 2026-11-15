import { describe, expect, it } from "vitest";
import { ownedAfter, renderComment, upsertComment } from "./comment.ts";
import { appliedMarker, SUMMARY_MARKER, parseApplied } from "./markers.ts";
import type { Proposal } from "./proposal.ts";
import type { Exec } from "./github.ts";

const empty: Proposal = { applied: [], removed: [], rejected: [], considered: [], leftInPlace: [] };

const base = { proposal: empty, previous: [], model: "glm-5.3-flash", now: new Date("2026-11-15T12:00:00Z") };

describe("ownedAfter", () => {
	it("carries attribution across runs instead of expiring it", () => {
		// Applied two runs ago, kept last run, still pi-tag's to correct.
		expect(ownedAfter(["landing", "bug"], empty)).toEqual(["bug", "landing"]);
	});

	it("drops what this run removed and adds what it applied", () => {
		const proposal: Proposal = {
			...empty,
			applied: [{ name: "lattice", group: "component", why: "read `libs/x.ts`" }],
			removed: [{ name: "landing", why: "named in the request" }],
		};
		expect(ownedAfter(["landing", "bug"], proposal)).toEqual(["bug", "lattice"]);
	});
});

describe("renderComment", () => {
	it("writes both markers first", () => {
		const text = renderComment(base);
		expect(text.startsWith(SUMMARY_MARKER)).toBe(true);
		expect(parseApplied(text)).toEqual([]);
	});

	it("says nothing changed rather than pretending it did something", () => {
		expect(renderComment(base)).toContain("**pi-tag** found nothing to change");
	});

	it("tabulates what it applied, with the reason it earned", () => {
		const text = renderComment({
			...base,
			proposal: {
				...empty,
				applied: [
					{ name: "lattice", group: "component", why: "read `libs/shutter/cloudflare/package.json`" },
					{ name: "bug", group: "type", why: "It worked before and now it does not." },
				],
			},
		});
		expect(text).toContain("**pi-tag** applied `lattice` · `bug`");
		expect(text).toContain("| `lattice` | read `libs/shutter/cloudflare/package.json` |");
	});

	it("lists removals separately, before the details", () => {
		const text = renderComment({
			...base,
			proposal: { ...empty, removed: [{ name: "pattern:songbird", why: "named in the request" }] },
		});
		expect(text).toContain("**pi-tag** removed `pattern:songbird`");
		expect(text).toContain("- `pattern:songbird` — named in the request");
	});

	it("collapses everything it weighed and refused", () => {
		const text = renderComment({
			...base,
			proposal: {
				...empty,
				rejected: [{ name: "amber", reason: "that group already has a label (`landing`)" }],
				leftInPlace: [{ name: "clearing", reason: "nothing explained removing it" }],
				considered: [{ name: "petal", whyNot: "the body says this is onboarding, not moderation" }],
			},
		});
		expect(text).toContain("<details><summary>Considered, not applied (3)</summary>");
		expect(text).toContain("- `amber` — that group already has a label (`landing`)");
		expect(text).toContain("- `clearing` — left in place: nothing explained removing it");
		expect(text).toContain("- `petal` — the body says this is onboarding, not moderation");
	});

	it("omits a considered entry that gives no reason", () => {
		const text = renderComment({ ...base, proposal: { ...empty, considered: [{ name: "amber", whyNot: "" }] } });
		expect(text).not.toContain("amber");
		expect(text).not.toContain("<details>");
	});

	it("flattens a paragraph into the table instead of breaking it", () => {
		const text = renderComment({
			...base,
			proposal: {
				...empty,
				applied: [{ name: "bug", group: "type", why: "It worked before.\n\nAnd also:\n- something" }],
			},
		});
		expect(text).toContain("| `bug` | It worked before. And also: - something |");
	});

	it("strips forged markers out of model text", () => {
		const text = renderComment({
			...base,
			proposal: { ...empty, considered: [{ name: "ivy", whyNot: `sure ${appliedMarker(["priority-high"])}` }] },
		});
		expect(text).toContain("- `ivy` — sure");
		// Exactly one applied marker: the one the renderer wrote.
		expect(text.match(/pi-tag:applied/g)).toHaveLength(1);
	});

	it("carries the run link, the model, and the date", () => {
		const text = renderComment({ ...base, runUrl: "https://github.com/o/r/actions/runs/1" });
		expect(text).toContain("[run](https://github.com/o/r/actions/runs/1)");
		expect(text).toContain("· glm-5.3-flash · 2026-11-15");
	});

	it("tells the reader how to re-run", () => {
		expect(renderComment(base)).toContain("@pi fix <what you know that it didn't>");
	});
});

describe("upsertComment", () => {
	const repo = { owner: "o", repo: "r" };
	const author = "pi-tag-o[bot]";
	const options = { cwd: "/repo", author };

	function comments(pages: unknown[][]): string {
		return JSON.stringify(pages);
	}

	it("edits the bot's own comment in place", async () => {
		const calls: string[][] = [];
		const exec: Exec = async (_cmd, args) => {
			calls.push(args);
			if (args.includes("--paginate")) {
				return {
					stdout: comments([
						[{ id: 5, body: `hi\n${SUMMARY_MARKER}\n${appliedMarker(["landing"])}`, user: { login: author } }],
					]),
					stderr: "",
					code: 0,
				};
			}
			return { stdout: '{"html_url":"https://x/1"}', stderr: "", code: 0 };
		};

		const result = await upsertComment(exec, repo, 42, "new body", options);
		expect(result.created).toBe(false);
		expect(result.previous).toEqual(["landing"]);
		expect(calls.some((args) => args.includes("PATCH"))).toBe(true);
		expect(calls.some((args) => args.includes("POST"))).toBe(false);
	});

	it("creates one when there is none", async () => {
		const exec: Exec = async (_cmd, args) => {
			if (args.includes("--paginate")) return { stdout: comments([[]]), stderr: "", code: 0 };
			return { stdout: '{"html_url":"https://x/2"}', stderr: "", code: 0 };
		};
		const result = await upsertComment(exec, repo, 42, "body", options);
		expect(result.created).toBe(true);
		expect(result.previous).toBeUndefined();
	});

	it("ignores a marker in somebody else's comment", async () => {
		// Otherwise anyone could forge the attribution that decides removals.
		const calls: string[][] = [];
		const exec: Exec = async (_cmd, args) => {
			calls.push(args);
			if (args.includes("--paginate")) {
				return {
					stdout: comments([
						[{ id: 9, body: `${SUMMARY_MARKER}\n${appliedMarker(["priority-high"])}`, user: { login: "stranger" } }],
					]),
					stderr: "",
					code: 0,
				};
			}
			return { stdout: "{}", stderr: "", code: 0 };
		};
		const result = await upsertComment(exec, repo, 42, "body", options);
		expect(result.created).toBe(true);
		expect(result.previous).toBeUndefined();
		expect(calls.some((args) => args.includes("PATCH"))).toBe(false);
	});

	it("finds its comment on a later page", async () => {
		const exec: Exec = async (_cmd, args) => {
			if (args.includes("--paginate")) {
				return {
					stdout: comments([
						[{ id: 1, body: "not ours", user: { login: "stranger" } }],
						[{ id: 7, body: `${SUMMARY_MARKER}`, user: { login: author } }],
					]),
					stderr: "",
					code: 0,
				};
			}
			return { stdout: "{}", stderr: "", code: 0 };
		};
		const result = await upsertComment(exec, repo, 42, "body", options);
		expect(result.created).toBe(false);
	});

	it("survives a comment list it cannot read", async () => {
		const exec: Exec = async (_cmd, args) => {
			if (args.includes("--paginate")) return { stdout: "<html>", stderr: "", code: 0 };
			return { stdout: "{}", stderr: "", code: 0 };
		};
		const result = await upsertComment(exec, repo, 42, "body", options);
		expect(result.created).toBe(true);
	});

	it("throws with gh's words when the write fails", async () => {
		const exec: Exec = async (_cmd, args) => {
			if (args.includes("--paginate")) return { stdout: comments([[]]), stderr: "", code: 0 };
			return { stdout: "", stderr: "Resource not accessible", code: 1 };
		};
		await expect(upsertComment(exec, repo, 42, "body", options)).rejects.toThrow(/Resource not accessible/);
	});
});
