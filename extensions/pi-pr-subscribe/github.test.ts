import { describe, expect, it } from "vitest";
import type { Exec } from "./gh.ts";
import {
	hasGhAuth,
	listRemotes,
	matchesRemote,
	parseGitHubRemote,
	resolvePullForBranch,
	resolveRepo,
} from "./github.ts";

function fakeGit(outputs: Record<string, string | undefined>): Exec {
	return async (command, args) => {
		const key = [command, ...args].join(" ");
		const stdout = outputs[key];
		return stdout === undefined ? { stdout: "", code: 1 } : { stdout, code: 0 };
	};
}

describe("parseGitHubRemote", () => {
	it("reads the common remote forms", () => {
		expect(parseGitHubRemote("git@github.com:AutumnsGrove/pi-extensions.git")).toEqual({
			owner: "AutumnsGrove",
			repo: "pi-extensions",
		});
		expect(parseGitHubRemote("https://github.com/AutumnsGrove/pi-extensions")).toEqual({
			owner: "AutumnsGrove",
			repo: "pi-extensions",
		});
		expect(parseGitHubRemote("https://github.com/autumn/p.git/")).toEqual({ owner: "autumn", repo: "p" });
		expect(parseGitHubRemote("ssh://git@github.com/o/r")).toEqual({ owner: "o", repo: "r" });
		expect(parseGitHubRemote("ssh://git@github.com/o/r.git")).toEqual({ owner: "o", repo: "r" });
		expect(parseGitHubRemote("https://token@github.com/o/r.git")).toEqual({ owner: "o", repo: "r" });
	});

	it("ignores anything that is not GitHub", () => {
		expect(parseGitHubRemote("https://gitlab.com/o/r")).toBeUndefined();
		expect(parseGitHubRemote("git@github.com:o")).toBeUndefined();
		expect(parseGitHubRemote("")).toBeUndefined();
	});
});

describe("listRemotes", () => {
	it("puts origin first and dedupes", async () => {
		const exec = fakeGit({
			"git remote": "upstream\norigin",
			"git remote get-url origin": "git@github.com:o/r.git",
			"git remote get-url upstream": "https://github.com/o/r",
		});
		expect(await listRemotes(exec, "/tmp")).toEqual([{ owner: "o", repo: "r" }]);
	});

	it("skips a non-GitHub origin and keeps looking", async () => {
		const exec = fakeGit({
			"git remote": "origin\nfork",
			"git remote get-url origin": "https://gitlab.com/o/r",
			"git remote get-url fork": "git@github.com:me/r.git",
		});
		const remotes = await listRemotes(exec, "/tmp");
		expect(remotes).toEqual([{ owner: "me", repo: "r" }]);
		expect(await resolveRepo(exec, "/tmp")).toEqual({ owner: "me", repo: "r" });
	});

	it("returns nothing without a git remote", async () => {
		expect(await listRemotes(fakeGit({}), "/tmp")).toEqual([]);
		expect(await resolveRepo(fakeGit({}), "/tmp")).toBeUndefined();
	});
});

describe("matchesRemote", () => {
	it("compares owner and repo case-insensitively", () => {
		expect(matchesRemote([{ owner: "Autumn", repo: "Pi" }], "autumn", "pi")).toBe(true);
		expect(matchesRemote([{ owner: "Autumn", repo: "Pi" }], "autumn", "other")).toBe(false);
	});
});

describe("gh helpers", () => {
	it("detects auth", async () => {
		expect(await hasGhAuth(fakeGit({ "gh auth status": "ok" }), "/tmp")).toBe(true);
		expect(await hasGhAuth(fakeGit({}), "/tmp")).toBe(false);
	});

	it("reads the current branch's PR", async () => {
		const exec = fakeGit({
			"gh pr view --json number,url,state": '{"number":32,"url":"https://github.com/o/r/pull/32","state":"OPEN"}',
		});
		expect(await resolvePullForBranch(exec, "/tmp")).toEqual({
			number: 32,
			url: "https://github.com/o/r/pull/32",
		});
		expect(await resolvePullForBranch(fakeGit({}), "/tmp")).toBeUndefined();
		expect(
			await resolvePullForBranch(fakeGit({ "gh pr view --json number,url,state": "{}" }), "/tmp")
		).toBeUndefined();
		expect(
			await resolvePullForBranch(fakeGit({ "gh pr view --json number,url,state": "not json" }), "/tmp")
		).toBeUndefined();
	});
});
