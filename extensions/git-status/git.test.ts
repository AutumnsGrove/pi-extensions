import { describe, expect, it } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	collectGitStatus,
	formatGitDetails,
	parseBranchHeader,
	parseShortstat,
	parseStatus,
	renderGitStatus,
	type GitResult,
	type GitRunner,
} from "./git.ts";

/** A theme stub that strips color: assertions read the plain text. */
const plainTheme = { fg: (_color: string, text: string) => text } as unknown as Theme;

function fakeRunner(
	responses: Record<string, GitResult>
): GitRunner {
	return async (args: string[]) => {
		// Drop the global `--no-optional-locks` flag so keys stay readable.
		const key = args.filter((arg) => arg !== "--no-optional-locks").join(" ");
		return responses[key] ?? { stdout: "", code: 128 };
	};
}

describe("parseShortstat", () => {
	it("reads insertions and deletions", () => {
		expect(parseShortstat(" 3 files changed, 5 insertions(+), 2 deletions(-)")).toEqual({
			insertions: 5,
			deletions: 2,
		});
	});

	it("handles singular wording and a one-sided diff", () => {
		expect(parseShortstat(" 1 file changed, 1 insertion(+)")).toEqual({
			insertions: 1,
			deletions: 0,
		});
		expect(parseShortstat(" 1 file changed, 1 deletion(-)")).toEqual({
			insertions: 0,
			deletions: 1,
		});
	});

	it("returns zeros for empty or unrelated output", () => {
		expect(parseShortstat("")).toEqual({ insertions: 0, deletions: 0 });
		expect(parseShortstat(" 1 file changed, 1 insertion(+), 1 deletion(-)")?.insertions).toBe(1);
	});
});

describe("parseBranchHeader", () => {
	it("parses a bare branch", () => {
		expect(parseBranchHeader("feature/x")).toEqual({
			branch: "feature/x",
			detached: false,
			upstream: undefined,
			ahead: 0,
			behind: 0,
		});
	});

	it("parses an upstream with ahead/behind drift", () => {
		expect(parseBranchHeader("main...origin/main [ahead 1, behind 2]")).toEqual({
			branch: "main",
			detached: false,
			upstream: "origin/main",
			ahead: 1,
			behind: 2,
		});
	});

	it("parses an upstream without drift", () => {
		expect(parseBranchHeader("main...origin/main")).toEqual({
			branch: "main",
			detached: false,
			upstream: "origin/main",
			ahead: 0,
			behind: 0,
		});
	});

	it("treats a gone upstream as a branch with no tracking", () => {
		const parsed = parseBranchHeader("feature [gone]");
		expect(parsed.branch).toBe("feature");
		expect(parsed.upstream).toBeUndefined();
		expect(parsed.ahead).toBe(0);
		expect(parsed.behind).toBe(0);
	});

	it("recognizes a detached HEAD", () => {
		expect(parseBranchHeader("HEAD (no branch)").detached).toBe(true);
	});

	it("recognizes a repository with no commits yet", () => {
		expect(parseBranchHeader("No commits yet on main").branch).toBe("main");
	});
});

describe("parseStatus", () => {
	it("counts staged, modified, and untracked paths", () => {
		const parsed = parseStatus("## feature/x\0MM a.txt\0?? b.txt\0");
		expect(parsed.branch).toBe("feature/x");
		expect(parsed.changedFiles).toBe(2);
		expect(parsed.counts).toEqual({ staged: 1, unstaged: 1, untracked: 1, conflicts: 0 });
		expect(parsed.untrackedPaths).toEqual(["b.txt"]);
	});

	it("counts a rename once and skips its source path", () => {
		const parsed = parseStatus("## main\0R  new.txt\0old.txt\0");
		expect(parsed.changedFiles).toBe(1);
		expect(parsed.counts.staged).toBe(1);
	});

	it("classifies conflicts without double-counting them as staged", () => {
		const parsed = parseStatus("## main\0UU conflict.txt\0");
		expect(parsed.changedFiles).toBe(1);
		expect(parsed.counts).toEqual({ staged: 0, unstaged: 0, untracked: 0, conflicts: 1 });
	});

	it("keeps paths with spaces intact", () => {
		const parsed = parseStatus("## main\0?? my file.txt\0");
		expect(parsed.changedFiles).toBe(1);
		expect(parsed.counts.untracked).toBe(1);
	});

	it("reports a clean tree for a branch-only header", () => {
		const parsed = parseStatus("## main\0");
		expect(parsed.changedFiles).toBe(0);
		expect(parsed.counts).toEqual({ staged: 0, unstaged: 0, untracked: 0, conflicts: 0 });
	});
});

describe("collectGitStatus", () => {
	it("returns null when cwd is not a git repository", async () => {
		const run = fakeRunner({
			"status --porcelain -z --branch -uall": { stdout: "", code: 128 },
		});
		expect(await collectGitStatus(run)).toBeNull();
	});

	it("sums staged and unstaged line churn", async () => {
		const run = fakeRunner({
			"status --porcelain -z --branch -uall": {
				stdout: "## main...origin/main [ahead 1, behind 2]\0 M a.txt\0?? b.txt\0",
				code: 0,
			},
			"diff --shortstat": { stdout: " 1 file changed, 2 insertions(+)", code: 0 },
			"diff --cached --shortstat": { stdout: " 1 file changed, 3 insertions(+), 1 deletion(-)", code: 0 },
		});
		const status = await collectGitStatus(run);
		expect(status).not.toBeNull();
		expect(status).toMatchObject({
			branch: "main",
			upstream: "origin/main",
			ahead: 1,
			behind: 2,
			clean: false,
			changedFiles: 2,
			insertions: 5,
			deletions: 1,
		});
	});

	it("counts untracked file lines as insertions", async () => {
		const run = fakeRunner({
			"status --porcelain -z --branch -uall": {
				stdout: "## main\0 M a.txt\0?? new.txt\0?? empty.txt\0",
				code: 0,
			},
			"diff --shortstat": { stdout: " 1 file changed, 1 insertion(+)", code: 0 },
			"diff --cached --shortstat": { stdout: "", code: 0 },
			"rev-parse --show-toplevel": { stdout: "/repo\n", code: 0 },
		});
		const seen: string[] = [];
		const status = await collectGitStatus(run, {
			countUntrackedLines: async (root, path) => {
				seen.push(`${root}/${path}`);
				return path === "new.txt" ? 3 : 0;
			},
		});
		expect(seen).toEqual(["/repo/new.txt", "/repo/empty.txt"]);
		expect(status?.insertions).toBe(4); // 1 tracked + 3 untracked
		expect(status?.changedFiles).toBe(3);
	});

	it("resolves a short sha when HEAD is detached", async () => {
		const run = fakeRunner({
			"status --porcelain -z --branch -uall": { stdout: "## HEAD (no branch)\0", code: 0 },
			"rev-parse --short HEAD": { stdout: "d86d48d\n", code: 0 },
			"diff --shortstat": { stdout: "", code: 0 },
			"diff --cached --shortstat": { stdout: "", code: 0 },
		});
		const status = await collectGitStatus(run);
		expect(status?.detached).toBe(true);
		expect(status?.branch).toBe("d86d48d");
		expect(status?.clean).toBe(true);
	});
});

describe("renderGitStatus", () => {
	const dirty = {
		branch: "feature/x",
		detached: false,
		upstream: "origin/feature/x",
		ahead: 1,
		behind: 2,
		clean: false,
		changedFiles: 3,
		counts: { staged: 2, unstaged: 1, untracked: 1, conflicts: 0 },
		insertions: 42,
		deletions: 8,
	};

	it("shows branch, file count, churn, and drift", () => {
		const line = renderGitStatus(dirty, plainTheme, 200);
		expect(line).toContain("⎇ feature/x");
		expect(line).toContain("3 modified");
		expect(line).toContain("+42");
		expect(line).toContain("−8");
		expect(line).toContain("↑1");
		expect(line).toContain("↓2");
	});

	it("shows a clean tree as just the branch and drift", () => {
		const line = renderGitStatus({ ...dirty, clean: true, changedFiles: 0 }, plainTheme, 200);
		expect(line).toContain("⎇ feature/x");
		expect(line).not.toContain("modified");
		expect(line).not.toContain("+");
	});

	it("wraps a detached HEAD in parentheses", () => {
		const line = renderGitStatus({ ...dirty, detached: true, branch: "d86d48d" }, plainTheme, 200);
		expect(line).toContain("(d86d48d)");
	});

	it("truncates to the available width", () => {
		const line = renderGitStatus(dirty, plainTheme, 12);
		expect(visibleWidth(line)).toBeLessThanOrEqual(12);
	});
});

describe("formatGitDetails", () => {
	it("summarizes a dirty tree and its buckets", () => {
		const details = formatGitDetails({
			branch: "main",
			detached: false,
			upstream: "origin/main",
			ahead: 1,
			behind: 0,
			clean: false,
			changedFiles: 2,
			counts: { staged: 1, unstaged: 1, untracked: 1, conflicts: 0 },
			insertions: 5,
			deletions: 1,
		});
		expect(details).toContain("Branch: main");
		expect(details).toContain("Upstream: origin/main (1 ahead, 0 behind)");
		expect(details).toContain("Changed files: 2 (1 staged, 1 modified, 1 untracked)");
		expect(details).toContain("Lines: +5 −1");
	});

	it("keeps a clean tree to one line", () => {
		const details = formatGitDetails({
			branch: "main",
			detached: false,
			upstream: undefined,
			ahead: 0,
			behind: 0,
			clean: true,
			changedFiles: 0,
			counts: { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 },
			insertions: 0,
			deletions: 0,
		});
		expect(details).toBe("Branch: main");
	});
});
