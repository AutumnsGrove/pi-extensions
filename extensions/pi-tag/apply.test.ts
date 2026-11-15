import { describe, expect, it } from "vitest";
import { applyLabels, resolveRepo } from "./apply.ts";
import { parseArgs } from "./cli.ts";
import type { Exec } from "./github.ts";

const repo = { owner: "o", repo: "r" };

describe("applyLabels", () => {
	it("adds and removes in one call, so the issue is never half-changed", async () => {
		const calls: string[][] = [];
		const exec: Exec = async (_cmd, args) => {
			calls.push(args);
			return { stdout: "", stderr: "", code: 0 };
		};
		const result = await applyLabels(exec, 42, repo, { add: ["lattice", "bug"], remove: ["clearing"] }, { cwd: "/r" });
		expect(result).toEqual({ added: ["lattice", "bug"], removed: ["clearing"] });
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual([
			"issue",
			"edit",
			"42",
			"--repo",
			"o/r",
			"--add-label",
			"lattice,bug",
			"--remove-label",
			"clearing",
		]);
	});

	it("says nothing to GitHub when there is nothing to change", async () => {
		let called = false;
		const exec: Exec = async () => {
			called = true;
			return { stdout: "", stderr: "", code: 0 };
		};
		const result = await applyLabels(exec, 42, repo, { add: [], remove: [] }, { cwd: "/r" });
		expect(result).toEqual({ added: [], removed: [] });
		expect(called).toBe(false);
	});

	it("drops duplicates and never removes what it is adding", async () => {
		const calls: string[][] = [];
		const exec: Exec = async (_cmd, args) => {
			calls.push(args);
			return { stdout: "", stderr: "", code: 0 };
		};
		await applyLabels(exec, 42, repo, { add: ["bug", "bug"], remove: ["bug"] }, { cwd: "/r" });
		expect(calls[0]).not.toContain("--remove-label");
	});

	it("throws with gh's words when the write fails", async () => {
		const exec: Exec = async () => ({ stdout: "", stderr: "Label does not exist", code: 1 });
		await expect(applyLabels(exec, 42, repo, { add: ["nope"], remove: [] }, { cwd: "/r" })).rejects.toThrow(
			/Label does not exist/
		);
	});
});

describe("resolveRepo", () => {
	it("reads owner/repo from gh", async () => {
		const exec: Exec = async () => ({ stdout: "AutumnsGrove/Lattice\n", stderr: "", code: 0 });
		expect(await resolveRepo(exec, "/r")).toEqual({ owner: "AutumnsGrove", repo: "Lattice" });
	});

	it("returns nothing rather than guessing when gh fails", async () => {
		const exec: Exec = async () => ({ stdout: "", stderr: "no auth", code: 1 });
		expect(await resolveRepo(exec, "/r")).toBeUndefined();
	});
});

describe("parseArgs", () => {
	it("defaults to a dry run", () => {
		const args = parseArgs(["--issue", "1657"]);
		expect(args.apply).toBe(false);
		expect(args.timeoutMs).toBe(300_000);
		expect(args.author).toBe("github-actions[bot]");
	});

	it("takes the flags the workflow passes", () => {
		const args = parseArgs([
			"--repo",
			"/w",
			"--issue",
			"42",
			"--apply",
			"--author",
			"pi-tag-x[bot]",
			"--run-url",
			"https://x/1",
			"--fix",
			"`landing` is wrong",
			"--timeout",
			"90",
		]);
		expect(args).toMatchObject({
			repo: "/w",
			issue: 42,
			apply: true,
			author: "pi-tag-x[bot]",
			runUrl: "https://x/1",
			fix: "`landing` is wrong",
			timeoutMs: 90_000,
		});
	});

	it("knows which flags it was actually given", () => {
		expect(parseArgs(["--issue", "1"]).provided.size).toBe(1);
		expect(parseArgs(["--issue", "1", "--model", "x", "--thinking", "low"]).provided).toEqual(
			new Set(["--issue", "--model", "--thinking"])
		);
	});

	it("keeps an empty --fix, which is still a fix run", () => {
		const args = parseArgs(["--issue", "1", "--fix", ""]);
		expect(args.fix).toBe("");
		expect(args.fix !== undefined).toBe(true);
	});

	it("rejects a flag with no value and an unknown flag", () => {
		expect(() => parseArgs(["--issue"])).toThrow(/needs a value/);
		expect(() => parseArgs(["--nonsense"])).toThrow(/unknown option/);
	});
});
