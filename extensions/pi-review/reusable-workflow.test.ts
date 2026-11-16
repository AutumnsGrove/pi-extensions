/**
 * The job body itself, as checked in. The caller only points at it, so these are
 * the tests that protect what actually runs in every project: the guard runs
 * first, no secret reaches the dependency install, the App token is conditional,
 * and the extension source is fetched at the commit that defined the job.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { PACKAGE_REPO, REUSABLE_WORKFLOW_PATH, REUSABLE_REF } from "./workflow.ts";

interface Step {
	name?: string;
	uses?: string;
	id?: string;
	if?: string;
	env?: Record<string, string>;
	with?: Record<string, string | number | boolean>;
	run?: string;
	"timeout-minutes"?: number | string;
}

interface Reusable {
	on: {
		workflow_call: {
			inputs: Record<string, { type: string; default?: unknown }>;
			secrets: Record<string, { required: boolean }>;
		};
	};
	permissions: Record<string, string>;
	jobs: {
		review: {
			"runs-on": string;
			"timeout-minutes": number | string;
			env?: Record<string, string>;
			steps: Step[];
		};
	};
}

const source = fileURLToPath(new URL(`../../${REUSABLE_WORKFLOW_PATH}`, import.meta.url));
const text = readFileSync(source, "utf8");
const workflow = parse(text) as Reusable;
const steps = workflow.jobs.review.steps;

function step(name: string): Step {
	const found = steps.find((candidate) => candidate.name === name);
	if (!found) throw new Error(`no step named ${name}`);
	return found;
}

function indexOf(name: string): number {
	return steps.findIndex((candidate) => candidate.name === name);
}

describe("the reusable workflow", () => {
	it("is callable, declares its inputs, and asks for the secrets it uses", () => {
		expect(workflow.on.workflow_call.inputs["settings-path"]?.default).toBe(".github/pi-review.json");
		expect(workflow.on.workflow_call.inputs["job-timeout-minutes"]?.type).toBe("number");
		expect(workflow.on.workflow_call.inputs["install-dependencies"]?.type).toBe("boolean");
		expect(Object.keys(workflow.on.workflow_call.secrets)).toEqual([
			"PI_REVIEW_API_KEY",
			"PI_REVIEW_APP_ID",
			"PI_REVIEW_APP_PRIVATE_KEY",
		]);
		expect(workflow.permissions).toEqual({
			contents: "read",
			"pull-requests": "write",
			issues: "write",
		});
		expect(String(workflow.jobs.review["timeout-minutes"])).toContain("inputs.job-timeout-minutes");
	});

	it("checks the same-repo guard first, before anything touches the PR tree", () => {
		// Issue #33: the guard needs only `gh pr view`. Running it after the
		// checkout and the install means a fork's install scripts have already
		// run and the shared cache has already been written.
		expect(steps[0]?.name).toBe("Require a same-repo pull request");
		expect(steps[0]?.if).toBe("github.event_name == 'issue_comment'");
		expect(steps[0]?.run).toContain("gh pr view");
		expect(indexOf("Require a same-repo pull request")).toBeLessThan(
			steps.findIndex((candidate) => candidate.uses === "actions/checkout@v7")
		);
	});

	it("never puts a secret in the dependency install step", () => {
		const install = step("Install dependencies");
		expect(JSON.stringify(install.env ?? {})).not.toContain("secrets.");
		const installIndex = indexOf("Install dependencies");
		const before = steps.slice(0, installIndex);
		expect(JSON.stringify(before)).not.toContain("secrets.PI_REVIEW_API_KEY");
		// The provider key is exported only after the install, so a PR's own
		// scripts cannot read it from the environment.
		expect(indexOf("Read the settings")).toBeGreaterThan(installIndex);
		expect(step("Read the settings").env?.PI_REVIEW_PROVIDER_KEY).toBe(
			"${{ secrets.PI_REVIEW_API_KEY }}"
		);
	});

	it("mints the App token only when the App secrets are configured", () => {
		expect(workflow.jobs.review.env?.PI_REVIEW_APP_CONFIGURED).toBe(
			"${{ secrets.PI_REVIEW_APP_ID != '' && secrets.PI_REVIEW_APP_PRIVATE_KEY != '' }}"
		);
		expect(step("Mint the App token").if).toBe("env.PI_REVIEW_APP_CONFIGURED == 'true'");
		expect(step("Review").env?.GH_TOKEN).toBe(
			"${{ steps.app-token.outputs.token || github.token }}"
		);
	});

	it("reads the caller's settings at run time", () => {
		const settings = step("Read the settings");
		expect(settings.run).toContain("$PI_REVIEW_SETTINGS");
		for (const key of ["tools", "provider", "model", "thinking", "review.event", "pi.version"]) {
			expect(text).toContain(`.${key}`.replace(".review.event", ".review.event"));
		}
		expect(step("Install pi").run).toContain("jq -er '.pi.version'");
		expect(step("Check the settings file").run).toContain("not valid JSON");
	});

	it("checks the PR out and fetches the extension at the commit that defined the job", () => {
		const checkout = steps.find((candidate) => candidate.uses === "actions/checkout@v7");
		expect(checkout?.with?.ref).toBe(
			"refs/pull/${{ github.event.pull_request.number || github.event.issue.number }}/merge"
		);
		expect(checkout?.with?.["fetch-depth"]).toBe(0);
		// `job.workflow_sha` is the commit of the called workflow file. Step-level
		// env may read the `job` context; the job's `env:` may not, and
		// `github.job_workflow_sha` does not exist at all.
		const fetch = step("Check out pi-review");
		expect(fetch.env?.PI_REVIEW_SRC_REF).toBe("${{ job.workflow_sha }}");
		expect(text).not.toContain("${{ github.job_workflow_sha }}");
		expect(fetch.run).toContain(PACKAGE_REPO);
		expect(fetch.run).toContain('ref="${PI_REVIEW_SRC_REF:-main}"');
		expect(fetch.run).toContain("falling back to main");
	});

	it("pins the runner and the action majors", () => {
		// `ubuntu-latest` migrated to Ubuntu 26 in November 2026; a reviewer
		// should not change OS under a pull request because a label rotated.
		expect(String(workflow.jobs.review["runs-on"])).toBe("ubuntu-26.04");
		const uses = steps.map((candidate) => candidate.uses).filter(Boolean);
		expect(uses).toContain("actions/checkout@v7");
		expect(uses).toContain("actions/setup-node@v7");
		expect(uses).toContain("actions/create-github-app-token@v3");
		expect(uses).not.toContain("actions/cache@v4");
		// No cache: saving one needs `actions: write` in every caller (#34).
		expect(text).not.toContain("uses: actions/cache");
	});

	it("only uses contexts a job env may read", () => {
		// This is the bug that kept every caller from starting: `runner.temp` and
		// `github.job_workflow_sha` in the job env. `jobs.<job_id>.env` allows
		// github, needs, strategy, matrix, vars, secrets and inputs, nothing else.
		const jobEnv = workflow.jobs.review.env ?? {};
		for (const [key, value] of Object.entries(jobEnv)) {
			for (const match of String(value).matchAll(/\$\{\{\s*([a-zA-Z_]+)\./g)) {
				expect(["github", "needs", "strategy", "matrix", "vars", "secrets", "inputs"]).toContain(
					match[1]
				);
			}
			expect(key).toMatch(/^PI_REVIEW_/);
		}
	});

	it("runs one headless review and reports an incomplete one", () => {
		const review = step("Review");
		expect(review.run).toContain("--tools \"$PI_REVIEW_TOOLS\"");
		expect(review.run).toContain("--thinking \"$PI_REVIEW_THINKING\"");
		expect(review.run).toContain('"Review pull request #$PR_NUMBER."');
		expect(review.run).toContain("wrote no review artifact");
		expect(review.run).toContain("finished without submitting a review");
		expect(review.env?.PI_REVIEW_REQUEST).toBe("${{ github.event.comment.body }}");
		expect(step("Step summary").if).toBe("always()");
		expect(step("Report an incomplete review").if).toBe("failure()");
	});

	it("names the file the callers point at", () => {
		expect(REUSABLE_WORKFLOW_PATH).toBe(".github/workflows/pi-review-reusable.yml");
		expect(REUSABLE_REF).toBe("main");
	});
});
