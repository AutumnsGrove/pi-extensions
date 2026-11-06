import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Exec } from "../detect.ts";
import {
	SETUP_BRANCH,
	chooseBranchName,
	compareUrl,
	resolveDefaultBranch,
	writeWorkflowBranch,
} from "./git.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function repoDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-review-git-"));
	tempDirs.push(dir);
	return dir;
}

interface Call {
	command: string;
	args: string[];
}

function fakeExec(
	responses: Record<string, { stdout?: string; stderr?: string; code?: number }> = {}
): Exec & { calls: Call[] } {
	const calls: Call[] = [];
	const exec = async (command: string, args: string[]) => {
		calls.push({ command, args });
		const hit = responses[`${command} ${args.join(" ")}`];
		if (!hit) return { stdout: "", stderr: "", code: 0 };
		return { stdout: hit.stdout ?? "", stderr: hit.stderr ?? "", code: hit.code ?? 0 };
	};
	return Object.assign(exec, { calls });
}

const repo = { owner: "owner", repo: "repo" };
const files = [
	{ path: ".github/pi-review.json", content: '{"version":1}\n' },
	{ path: ".github/workflows/pi-review.yml", content: "name: pi-review\n" },
];

function baseResponses(): Record<string, { stdout?: string; stderr?: string; code?: number }> {
	return {
		"git rev-parse --abbrev-ref HEAD": { stdout: "feature\n" },
		"git status --porcelain": { stdout: "" },
		"git fetch origin main": { stdout: "" },
		"git ls-remote --heads origin pi-review/setup": { stdout: "" },
		"git checkout -B pi-review/setup origin/main": { stdout: "" },
		"git add -- .github/pi-review.json .github/workflows/pi-review.yml": { stdout: "" },
		"git status --porcelain -- .github/pi-review.json .github/workflows/pi-review.yml": {
			stdout: "A  .github/pi-review.json\nA  .github/workflows/pi-review.yml\n",
		},
		"git commit -m Add pi-review workflow and settings": { stdout: "" },
		"git push -u origin pi-review/setup": { stdout: "" },
		"git checkout feature": { stdout: "" },
	};
}

describe("resolveDefaultBranch", () => {
	it("asks GitHub for the default branch", async () => {
		const exec = fakeExec({ "gh api repos/owner/repo --jq .default_branch": { stdout: "main" } });
		expect(await resolveDefaultBranch(exec, "/repo", repo)).toBe("main");
	});
});

describe("chooseBranchName", () => {
	it("uses the plain setup branch when it is free", async () => {
		expect(await chooseBranchName(fakeExec(), "/repo")).toBe(SETUP_BRANCH);
	});

	it("suffixes when the branch already exists", async () => {
		const exec = fakeExec({
			"git ls-remote --heads origin pi-review/setup": { stdout: "sha\trefs/heads/pi-review/setup" },
			"git ls-remote --heads origin pi-review/setup-2": { stdout: "" },
		});
		expect(await chooseBranchName(exec, "/repo")).toBe("pi-review/setup-2");
	});
});

describe("compareUrl", () => {
	it("builds the PR-compare URL", () => {
		expect(compareUrl(repo, "main", "pi-review/setup")).toBe(
			"https://github.com/owner/repo/compare/main...pi-review/setup?expand=1"
		);
	});
});

describe("writeWorkflowBranch", () => {
	it("writes, commits, pushes, and restores the original branch", async () => {
		const cwd = await repoDir();
		const exec = fakeExec(baseResponses());
		const result = await writeWorkflowBranch({
			exec,
			cwd,
			repo,
			defaultBranch: "main",
			files,
			message: "Add pi-review workflow and settings",
		});

		expect(result).toMatchObject({
			branch: "pi-review/setup",
			committed: true,
			pushed: true,
			restoredBranch: "feature",
			files: [".github/pi-review.json", ".github/workflows/pi-review.yml"],
		});
		expect(await readFile(join(cwd, ".github/pi-review.json"), "utf8")).toBe('{"version":1}\n');
		const order = exec.calls.map((call) => call.args.join(" "));
		expect(order).toContain("checkout -B pi-review/setup origin/main");
		expect(order.indexOf("commit -m Add pi-review workflow and settings")).toBeLessThan(
			order.indexOf("push -u origin pi-review/setup")
		);
		expect(order.at(-1)).toBe("checkout feature");
	});

	it("does not commit when the generated files are unchanged", async () => {
		const cwd = await repoDir();
		const responses = baseResponses();
		responses["git status --porcelain -- .github/pi-review.json .github/workflows/pi-review.yml"] = {
			stdout: "",
		};
		const exec = fakeExec(responses);
		const result = await writeWorkflowBranch({
			exec,
			cwd,
			repo,
			defaultBranch: "main",
			files,
			message: "Add pi-review workflow and settings",
		});
		expect(result.committed).toBe(false);
		expect(result.pushed).toBe(false);
		expect(exec.calls.some((call) => call.args[0] === "commit")).toBe(false);
		expect(exec.calls.some((call) => call.args[0] === "push")).toBe(false);
	});

	it("refuses a dirty working tree before touching git", async () => {
		const cwd = await repoDir();
		const responses = baseResponses();
		responses["git status --porcelain"] = { stdout: " M src/app.ts\n" };
		const exec = fakeExec(responses);
		await expect(
			writeWorkflowBranch({ exec, cwd, repo, defaultBranch: "main", files, message: "m" })
		).rejects.toThrow("uncommitted changes");
		expect(exec.calls.some((call) => call.args[0] === "fetch")).toBe(false);
	});

	it("surfaces a push failure and still restores the branch", async () => {
		const cwd = await repoDir();
		const responses = baseResponses();
		responses["git push -u origin pi-review/setup"] = { stderr: "protected branch", code: 1 };
		const exec = fakeExec(responses);
		await expect(
			writeWorkflowBranch({ exec, cwd, repo, defaultBranch: "main", files, message: "m" })
		).rejects.toThrow("protected branch");
		expect(exec.calls.at(-1)?.args.join(" ")).toBe("checkout feature");
	});

	it("fails clearly when the checkout cannot be created", async () => {
		const cwd = await repoDir();
		const responses = baseResponses();
		responses["git checkout -B pi-review/setup origin/main"] = { stderr: "no such ref", code: 1 };
		const exec = fakeExec(responses);
		await expect(
			writeWorkflowBranch({ exec, cwd, repo, defaultBranch: "main", files, message: "m" })
		).rejects.toThrow("git checkout -B pi-review/setup failed");
	});
});
