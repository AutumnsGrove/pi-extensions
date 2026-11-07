import { describe, expect, it } from "vitest";
import { loadGuidance, loadReviewTarget } from "./context.ts";
import {
	type Exec,
	parseGitHubRemote,
	providerEnvName,
	resolveBaseRef,
	run,
} from "./detect.ts";

function fakeExec(responses: Record<string, { stdout?: string; code?: number }>): Exec {
	return async (command, args) => {
		const hit = responses[`${command} ${args.join(" ")}`];
		if (!hit) return { stdout: "", stderr: "not found", code: 1 };
		return { stdout: hit.stdout ?? "", stderr: "", code: hit.code ?? 0 };
	};
}

describe("parseGitHubRemote", () => {
	it("accepts the usual remote forms", () => {
		expect(parseGitHubRemote("git@github.com:AutumnsGrove/pi-extensions.git")).toEqual({
			owner: "AutumnsGrove",
			repo: "pi-extensions",
		});
		expect(parseGitHubRemote("https://github.com/owner/repo.git")).toEqual({
			owner: "owner",
			repo: "repo",
		});
		expect(parseGitHubRemote("https://github.com/owner/repo/")).toEqual({ owner: "owner", repo: "repo" });
		expect(parseGitHubRemote("ssh://git@github.com/owner/repo")).toEqual({ owner: "owner", repo: "repo" });
	});

	it("rejects non-github and malformed remotes", () => {
		expect(parseGitHubRemote("git@gitlab.com:owner/repo.git")).toBeUndefined();
		expect(parseGitHubRemote("https://github.com/owner")).toBeUndefined();
		expect(parseGitHubRemote("")).toBeUndefined();
	});
});

describe("providerEnvName", () => {
	it("maps the providers the installer supports", () => {
		expect(providerEnvName("opencode-go")).toBe("OPENCODE_API_KEY");
		expect(providerEnvName("openrouter")).toBe("OPENROUTER_API_KEY");
		expect(providerEnvName("Anthropic")).toBe("ANTHROPIC_API_KEY");
		expect(providerEnvName("unknown-provider")).toBeUndefined();
	});
});

describe("run", () => {
	it("returns trimmed stdout only on success", async () => {
		const exec = fakeExec({
			"git rev-parse HEAD": { stdout: "  abc123  \n" },
			"git status": { stdout: "ignored", code: 1 },
		});
		expect(await run(exec, "git", ["rev-parse", "HEAD"], { cwd: "/repo" })).toBe("abc123");
		expect(await run(exec, "git", ["status"], { cwd: "/repo" })).toBeUndefined();
		expect(await run(exec, "git", ["missing"], { cwd: "/repo" })).toBeUndefined();
	});

	it("swallows a throwing exec", async () => {
		const exec: Exec = async () => {
			throw new Error("ENOENT");
		};
		expect(await run(exec, "gh", ["auth", "status"], { cwd: "/repo" })).toBeUndefined();
	});
});

describe("resolveBaseRef", () => {
	it("prefers an explicit ref, then origin/HEAD, then defaults", async () => {
		const exec = fakeExec({
			"git rev-parse --verify --quiet refs/remotes/origin/HEAD^{commit}": { stdout: "sha" },
			"git symbolic-ref --short refs/remotes/origin/HEAD": { stdout: "origin/develop" },
			"git rev-parse --verify --quiet develop^{commit}": { stdout: "sha" },
			"git rev-parse --verify --quiet release^{commit}": { stdout: "sha" },
		});
		expect(await resolveBaseRef(exec, "/repo", undefined, {})).toBe("develop");
		expect(await resolveBaseRef(exec, "/repo", "release", {})).toBe("release");
	});

	it("falls back to the remote default branch when the local one is absent", async () => {
		const exec = fakeExec({
			"git symbolic-ref --short refs/remotes/origin/HEAD": { stdout: "origin/develop" },
			"git rev-parse --verify --quiet origin/develop^{commit}": { stdout: "sha" },
		});
		expect(await resolveBaseRef(exec, "/repo", undefined, {})).toBe("origin/develop");
	});

	it("resolves an explicit base that only exists as a remote-tracking ref", async () => {
		const exec = fakeExec({
			"git rev-parse --verify --quiet origin/release^{commit}": { stdout: "sha" },
		});
		expect(await resolveBaseRef(exec, "/repo", "release", {})).toBe("origin/release");
	});

	it("returns undefined when no candidate ref exists", async () => {
		expect(await resolveBaseRef(fakeExec({}), "/repo", undefined, {})).toBeUndefined();
	});

	it("reads the base ref from the environment", async () => {
		const exec = fakeExec({
			"git rev-parse --verify --quiet trunk^{commit}": { stdout: "sha" },
		});
		expect(await resolveBaseRef(exec, "/repo", undefined, { PI_REVIEW_BASE_REF: "trunk" })).toBe("trunk");
	});
});

describe("loadReviewTarget", () => {
	const view = {
		number: 12,
		title: "Add feature",
		body: "Body text",
		author: { login: "octocat" },
		baseRefName: "main",
		baseRefOid: "base-sha",
		headRefOid: "head-sha",
	};

	it("uses gh metadata and the PR diff", async () => {
		const exec = fakeExec({
			"git remote get-url origin": { stdout: "git@github.com:owner/repo.git" },
			"gh pr view 12 --json number,title,body,author,baseRefName,baseRefOid,headRefOid": {
				stdout: JSON.stringify(view),
			},
			"gh pr diff 12": { stdout: "PR DIFF" },
		});
		const target = await loadReviewTarget({ exec, cwd: "/repo", prNumber: 12, env: {} });
		expect(target.source).toBe("pull-request");
		expect(target.repo).toEqual({ owner: "owner", repo: "repo" });
		expect(target.title).toBe("Add feature");
		expect(target.author).toBe("octocat");
		expect(target.baseRef).toBe("main");
		expect(target.baseSha).toBe("base-sha");
		expect(target.headSha).toBe("head-sha");
		expect(target.diff).toBe("PR DIFF");
		expect(target.notes).toEqual([]);
	});

	it("reads the PR number from the environment", async () => {
		const exec = fakeExec({
			"gh pr view 12 --json number,title,body,author,baseRefName,baseRefOid,headRefOid": {
				stdout: JSON.stringify(view),
			},
			"gh pr diff 12": { stdout: "PR DIFF" },
		});
		const target = await loadReviewTarget({ exec, cwd: "/repo", env: { PR_NUMBER: "12" } });
		expect(target.number).toBe(12);
	});

	it("falls back to a local diff and notes the gh failure", async () => {
		const exec = fakeExec({
			"git remote get-url origin": { stdout: "https://github.com/owner/repo" },
			"git rev-parse --verify --quiet origin/main^{commit}": { stdout: "sha" },
			"git merge-base origin/main HEAD": { stdout: "merge-sha" },
			"git rev-parse HEAD": { stdout: "head-sha" },
			"git diff --no-color --no-ext-diff merge-sha": { stdout: "LOCAL DIFF" },
			"git log -1 --pretty=%s": { stdout: "Local commit" },
		});
		const target = await loadReviewTarget({ exec, cwd: "/repo", prNumber: 12, env: {} });
		expect(target.source).toBe("local");
		expect(target.number).toBe(12);
		expect(target.baseRef).toBe("origin/main");
		expect(target.baseSha).toBe("merge-sha");
		expect(target.diff).toBe("LOCAL DIFF");
		expect(target.headSha).toBeUndefined();
		expect(target.notes.join("\n")).toContain("Could not read pull request #12");
		expect(target.notes.join("\n")).toContain("omit `commit_id`");
	});

	it("reviews the working tree against the merge base without a PR", async () => {
		const exec = fakeExec({
			"git remote get-url origin": { stdout: "git@github.com:owner/repo.git" },
			"git rev-parse --verify --quiet main^{commit}": { stdout: "sha" },
			"git merge-base main HEAD": { stdout: "merge-sha" },
			"git rev-parse HEAD": { stdout: "head-sha" },
			"git diff --no-color --no-ext-diff merge-sha": { stdout: "WORKTREE DIFF" },
			"git log -1 --pretty=%s": { stdout: "Latest commit" },
		});
		const target = await loadReviewTarget({ exec, cwd: "/repo", env: {} });
		expect(target.source).toBe("local");
		expect(target.number).toBeUndefined();
		expect(target.title).toBe("Latest commit");
		expect(target.diff).toBe("WORKTREE DIFF");
	});
});

describe("loadGuidance", () => {
	it("reads guidance from the base commit and skips missing files", async () => {
		const exec = fakeExec({
			"git show base:REVIEW.md": { stdout: "Review rules" },
			"git show base:.github/REVIEW.md": { code: 128 },
			"git show base:AGENTS.md": { stdout: "Agent rules" },
		});
		const files = await loadGuidance(exec, "/repo", "base");
		expect(files.map((file) => file.path)).toEqual(["REVIEW.md", "AGENTS.md"]);
		expect(files[0]!.text).toBe("Review rules");
	});

	it("caps oversized guidance", async () => {
		const exec = fakeExec({
			"git show base:REVIEW.md": { stdout: "x".repeat(33_000) },
		});
		const files = await loadGuidance(exec, "/repo", "base", ["REVIEW.md"]);
		expect(files[0]!.truncated).toBe(true);
		expect(files[0]!.text.endsWith("[truncated]")).toBe(true);
	});

	it("loads nothing without a base commit", async () => {
		expect(await loadGuidance(fakeExec({}), "/repo", undefined)).toEqual([]);
	});
});
