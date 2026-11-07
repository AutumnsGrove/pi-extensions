import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Exec } from "./detect.ts";
import type { CommandRunner } from "./github/exec.ts";
import type { BranchOptions, BranchResult } from "./github/git.ts";
import { APP_ID_SECRET, APP_KEY_SECRET, APP_SLUG_VARIABLE } from "./github/secrets.ts";
import { API_KEY_SECRET, type WizardUI } from "./install.ts";
import { SETTINGS_PATH, WORKFLOW_PATH } from "./settings.ts";
import { renderUninstallOutcome, uninstallPiReview } from "./uninstall.ts";

const repo = { owner: "owner", repo: "repo" };
/** Never let a test reach the real browser opener. */
const noBrowser = async () => true;
const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function repoDir(files: string[] = []): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-review-uninstall-"));
	tempDirs.push(dir);
	for (const path of files) {
		await mkdir(join(dir, path, ".."), { recursive: true });
		await writeFile(join(dir, path), "{}", "utf8");
	}
	return dir;
}

function scriptedUi(answers: { confirm?: (boolean | undefined)[] } = {}): WizardUI & {
	notifications: { message: string; type?: string }[];
} {
	const queue = [...(answers.confirm ?? [])];
	const notifications: { message: string; type?: string }[] = [];
	return {
		notifications,
		async confirm() {
			if (queue.length === 0) throw new Error("no scripted confirm left");
			return queue.shift() as boolean;
		},
		async select() {
			return undefined;
		},
		async input() {
			return undefined;
		},
		notify(message, type) {
			notifications.push({ message, ...(type ? { type } : {}) });
		},
	};
}

function fakeExec(): Exec {
	const responses: Record<string, string> = {
		"git remote get-url origin": "git@github.com:owner/repo.git",
		"gh auth status": "ok",
		"gh api repos/owner/repo --jq .permissions.admin": "true",
		"gh api repos/owner/repo --jq .default_branch": "main",
	};
	return async (command, args) => {
		const key = `${command} ${args.join(" ")}`;
		return key in responses
			? { stdout: responses[key]!, stderr: "", code: 0 }
			: { stdout: "", stderr: "not found", code: 1 };
	};
}

function fakeRunner(options: { secrets?: string[]; slug?: string } = {}): CommandRunner & {
	calls: string[][];
} {
	const calls: string[][] = [];
	const runner = (async (_command: string, args: string[]) => {
		calls.push(args);
		if (args[0] === "api" && args[1]?.includes("/actions/secrets")) {
			return { stdout: (options.secrets ?? []).join("\n"), stderr: "", code: 0 };
		}
		if (args[0] === "variable" && args[1] === "get") {
			return options.slug
				? { stdout: `${options.slug}\n`, stderr: "", code: 0 }
				: { stdout: "", stderr: "not found", code: 1 };
		}
		if (args[0] === "secret" || args[0] === "variable") {
			return { stdout: "", stderr: "", code: 0 };
		}
		return { stdout: "", stderr: "unexpected", code: 1 };
	}) as CommandRunner;
	return Object.assign(runner, { calls });
}

function fakeWriter(result?: Partial<BranchResult>): {
	writeBranch: (options: BranchOptions) => Promise<BranchResult>;
	calls: BranchOptions[];
} {
	const calls: BranchOptions[] = [];
	const writeBranch = async (options: BranchOptions): Promise<BranchResult> => {
		calls.push(options);
		return {
			branch: "pi-review/remove",
			compareUrl: "https://github.com/owner/repo/compare/main...pi-review/remove?expand=1",
			committed: true,
			pushed: true,
			files: options.deletePaths ?? [],
			...result,
		};
	};
	return { writeBranch, calls };
}

describe("uninstallPiReview", () => {
	it("stops early when nothing is installed", async () => {
		const cwd = await repoDir();
		const ui = scriptedUi();
		const outcome = await uninstallPiReview({
			cwd,
			ui,
			deps: { exec: fakeExec(), run: fakeRunner(), writeBranch: fakeWriter().writeBranch, openUrl: noBrowser },
		});
		expect(outcome).toMatchObject({ status: "done", nothingToDo: true, changed: [] });
		expect(renderUninstallOutcome(outcome)).toContain("Nothing to remove");
	});

	it("removes the files on a branch and deletes the credentials", async () => {
		const cwd = await repoDir([SETTINGS_PATH, WORKFLOW_PATH]);
		const runner = fakeRunner({
			secrets: [API_KEY_SECRET, APP_ID_SECRET, APP_KEY_SECRET],
			slug: "pi-review-x",
		});
		const writer = fakeWriter();
		const opened: string[] = [];
		const ui = scriptedUi({ confirm: [true, true] });
		const outcome = await uninstallPiReview({
			cwd,
			ui,
			deps: {
				exec: fakeExec(),
				run: runner,
				writeBranch: writer.writeBranch,
				openUrl: async (url) => {
					opened.push(url);
					return true;
				},
			},
		});

		expect(writer.calls[0]).toMatchObject({
			branch: "pi-review/remove",
			files: [],
			deletePaths: [SETTINGS_PATH, WORKFLOW_PATH],
			message: "Remove pi-review workflow and settings",
		});
		expect(outcome.secretsRemoved).toEqual([API_KEY_SECRET, APP_ID_SECRET, APP_KEY_SECRET]);
		expect(outcome.changed).toContain(APP_SLUG_VARIABLE);
		expect(opened).toEqual(["https://github.com/owner/repo/compare/main...pi-review/remove?expand=1"]);

		const deletes = runner.calls.filter((args) => args[1] === "delete").map((args) => args[2]);
		expect(deletes).toEqual([API_KEY_SECRET, APP_ID_SECRET, APP_KEY_SECRET, APP_SLUG_VARIABLE]);
		const summary = renderUninstallOutcome(outcome);
		expect(summary).toContain("pi-review/remove");
		expect(summary).toContain("https://github.com/settings/apps/pi-review-x/advanced");
	});

	it("aborts at the plan without changing anything", async () => {
		const cwd = await repoDir([SETTINGS_PATH]);
		const writer = fakeWriter();
		const runner = fakeRunner({ secrets: [API_KEY_SECRET] });
		const outcome = await uninstallPiReview({
			cwd,
			ui: scriptedUi({ confirm: [false] }),
			deps: { exec: fakeExec(), run: runner, writeBranch: writer.writeBranch, openUrl: noBrowser },
		});
		expect(outcome.status).toBe("aborted");
		expect(writer.calls).toHaveLength(0);
		expect(runner.calls.some((args) => args[1] === "delete")).toBe(false);
	});

	it("keeps the credentials when the second confirmation is declined", async () => {
		const cwd = await repoDir([SETTINGS_PATH]);
		const runner = fakeRunner({ secrets: [API_KEY_SECRET] });
		const outcome = await uninstallPiReview({
			cwd,
			ui: scriptedUi({ confirm: [true, false] }),
			deps: { exec: fakeExec(), run: runner, writeBranch: fakeWriter().writeBranch, openUrl: noBrowser },
		});
		expect(outcome.secretsRemoved).toEqual([]);
		expect(runner.calls.some((args) => args[1] === "delete")).toBe(false);
		expect(outcome.workflow).toBeDefined();
	});

	it("reports a branch failure but still offers to delete the credentials", async () => {
		const cwd = await repoDir([WORKFLOW_PATH]);
		const runner = fakeRunner({ secrets: [APP_ID_SECRET] });
		const outcome = await uninstallPiReview({
			cwd,
			ui: scriptedUi({ confirm: [true, true] }),
			deps: {
				exec: fakeExec(),
				run: runner,
				writeBranch: async () => {
					throw new Error("remote rejected");
				},
				openUrl: noBrowser,
			},
		});
		expect(outcome.workflowError).toContain("remote rejected");
		expect(outcome.secretsRemoved).toEqual([APP_ID_SECRET]);
		expect(renderUninstallOutcome(outcome)).toContain("removal branch failed");
	});
});

describe("renderUninstallOutcome", () => {
	it("reports cancellation and the no-slug path", () => {
		expect(renderUninstallOutcome({ status: "aborted", repo, changed: [], secretsRemoved: [] })).toContain(
			"cancelled"
		);
		const text = renderUninstallOutcome({
			status: "done",
			repo,
			changed: [],
			secretsRemoved: [],
		});
		expect(text).toContain("https://github.com/settings/installations");
		expect(text).toContain("https://github.com/settings/apps");
	});
});
