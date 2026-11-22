/**
 * The job body itself, as checked in. The caller only points at it, so these are
 * the tests that protect what actually runs in every project: the guard runs
 * first, no secret reaches the dependency install, the App token is conditional,
 * and the extension source is fetched at the commit that defined the job.
 */
import { execFileSync } from "node:child_process";
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
	"continue-on-error"?: boolean | string;
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
			"cache-mode"?: string;
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
		// The guard runs before the checkout, so `gh` cannot infer the repository
		// from a working tree. Omitting `--repo` failed the mention path with
		// "not a git repository" for every `@pi` comment.
		expect(steps[0]?.run).toContain('--repo "${{ github.repository }}"');
		expect(indexOf("Require a same-repo pull request")).toBeLessThan(
			steps.findIndex((candidate) => candidate.uses === "actions/checkout@v7")
		);
	});

	it("never puts a secret in the dependency install step", () => {
		const install = step("Install pi and dependencies");
		expect(JSON.stringify(install.env ?? {})).not.toContain("secrets.");
		const installIndex = indexOf("Install pi and dependencies");
		const before = steps.slice(0, installIndex);
		expect(JSON.stringify(before)).not.toContain("secrets.PI_REVIEW_API_KEY");
		// The provider key is exported only after the install, so a PR's own
		// scripts cannot read it from the environment.
		expect(indexOf("Read the settings")).toBeGreaterThan(installIndex);
		expect(step("Read the settings").env?.PI_REVIEW_PROVIDER_KEY).toBe(
			"${{ secrets.PI_REVIEW_API_KEY }}"
		);
	});

	it("names the repository in every gh call that may run without a checkout", () => {
		const guardLines = (step("Require a same-repo pull request").run ?? "")
			.split("\n")
			.filter((line) => /\bgh pr\b/.test(line));
		expect(guardLines.length).toBeGreaterThan(0);
		for (const line of guardLines) expect(line).toContain("--repo");
		// The recovery and failure-comment steps use the REST API, which needs
		// the repository named explicitly when the checkout was skipped.
		for (const name of ["Recover the review", "Report or clear an incomplete review"]) {
			const apiLines = (step(name).run ?? "").split("\n").filter((line) => /\bgh api\b/.test(line));
			expect(apiLines.length).toBeGreaterThan(0);
			for (const line of apiLines) expect(line).toContain("$GITHUB_REPOSITORY");
		}
	});

	it("mints the App token only when the App secrets are configured", () => {
		expect(workflow.jobs.review.env?.PI_REVIEW_APP_CONFIGURED).toBe(
			"${{ secrets.PI_REVIEW_APP_ID != '' && secrets.PI_REVIEW_APP_PRIVATE_KEY != '' }}"
		);
		expect(step("Mint the App token").if).toBe("env.PI_REVIEW_APP_CONFIGURED == 'true'");
		const mint = step("Mint the App token");
		expect(mint.with?.["client-id"]).toBe("${{ secrets.PI_REVIEW_APP_ID }}");
		expect(mint.with?.["app-id"]).toBeUndefined();
		expect(mint.with?.["permission-pull-requests"]).toBe("write");
		expect(mint.with?.["permission-issues"]).toBe("write");
		expect(step("Review").env?.GH_TOKEN).toBe(
			"${{ steps.app-token.outputs.token || github.token }}"
		);
	});

	it("reads the caller's settings at run time", () => {
		const settings = step("Read the settings");
		expect(settings.run).toContain("$PI_REVIEW_SETTINGS");
		for (const key of [
			"tools",
			"provider",
			"model",
			"thinking",
			"review.event",
			"review.retry",
			"review.onProviderFailure",
			"pi.version",
		]) {
			expect(text).toContain(`.${key}`);
		}
		expect(step("Install pi and dependencies").run).toContain("jq -r '.pi.version // \"\"'");
		// A pinned settings value wins, the input is the fallback, and neither
		// fails loudly instead of resolving `@latest`.
		expect(step("Install pi and dependencies").env?.PI_REVIEW_PI_VERSION).toBe(
			"${{ inputs.pi-version }}"
		);
		expect(step("Install pi and dependencies").run).toContain(
			"${PI_REVIEW_PI_VERSION:-}"
		);
		expect(step("Install pi and dependencies").run).toContain("::error::No pi version");
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
		// Node 20 is deprecated on the runner; these majors target Node 24.
		expect(uses).toContain("actions/cache@v6");
		expect(uses).toContain("actions/upload-artifact@v7");
		expect(uses).not.toContain("actions/cache@v4");
	});

	it("restores the pi install and the package stores without a caller change", () => {
		// The cache key includes the settings file (which carries an optional
		// `pi.version`) as well as the inherited `pi-version` input, so bumping
		// the workflow default invalidates the cached pi prefix; `restore-keys`
		// falls back to the settings hash so a lockfile change still seeds the
		// stores.
		expect(workflow.jobs.review["cache-mode"]).toBe("write");
		const cache = step("Restore pi and package caches");
		expect(cache.with?.path).toContain("${{ runner.temp }}/pi-review/pi");
		expect(cache.with?.key).toContain("hashFiles('**/pi-review.json')");
		expect(cache.with?.key).toContain("${{ inputs.pi-version }}");
		expect(cache.with?.key).toContain("pnpm-lock.yaml");
		expect(cache.with?.["restore-keys"]).toContain("pi-review-");
		// The cache is restored before the install that fills it, and never in a
		// step that can see a secret.
		expect(indexOf("Restore pi and package caches")).toBeLessThan(indexOf("Install pi and dependencies"));
		expect(indexOf("Read the settings")).toBeGreaterThan(indexOf("Install pi and dependencies"));
	});

	it("installs pi beside the checkout, from the cache when the version matches", () => {
		const install = step("Install pi and dependencies");
		// A fresh install goes into a directory the cache restores, and the same
		// version is not reinstalled.
		expect(install.run).toContain('prefix="$RUNNER_TEMP/pi-review/pi"');
		expect(install.run).toContain('"$prefix/bin/pi" --version');
		expect(install.run).toContain("npm install -g --prefix \"$prefix\"");
		expect(install.run).toContain('echo "$prefix/bin" >> "$GITHUB_PATH"');
		// A failed dependency install is a warning; a failed pi install is not.
		expect(install.run).toContain("Some dependency installs failed");
		expect(install.run).toContain("Could not install pi");
		expect(install["continue-on-error"]).toBeUndefined();
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

	it("runs one headless review without deciding the outcome in that step", () => {
		const review = step("Review");
		expect(review.run).toContain("--tools \"$PI_REVIEW_TOOLS\"");
		expect(review.run).toContain("--thinking \"$PI_REVIEW_THINKING\"");
		expect(review.run).toContain('"Review pull request #$PR_NUMBER."');
		expect(review.run).toContain("status=$?");
		expect(review.run).toContain("PI_PI_EXIT=$status");
		expect(review.run).toContain("run-meta.json");
		expect(review.env?.PI_REVIEW_REQUEST).toBe("${{ github.event.comment.body }}");
		expect(review.env?.PI_CODING_AGENT_DIR).toBe("${{ runner.temp }}/pi-review/agent");
	});

	it("keeps the agent's own text off stdout, where the runner reads commands", () => {
		// Issue #71: `pi --mode json | tee` put model text on stdout, and the
		// runner finds `##[` *anywhere* in a line (`ActionCommand.TryParse` uses
		// `IndexOf`, not a prefix check), so checking `actions/*` source printed
		// `##[add-matcher]` as a command and failed an already-posted review.
		const review = step("Review");
		expect(review.run).not.toContain("| tee");
		expect(review.run).toContain('> "$PI_REVIEW_EVENTS" 2> "$work/stderr.log"');

		// Anything echoed from the run goes through the neutraliser, so a future
		// `echo` cannot reopen the hole.
		const definition = (review.run ?? "").match(/quiet\(\) \{[^\n]*?\}/)?.[0];
		expect(definition).toBeTruthy();
		const echoes = (review.run ?? "")
			.split("\n")
			.filter((line) => line.includes("quiet") && !line.includes("quiet() {"));
		expect(echoes.length).toBeGreaterThanOrEqual(2);
		for (const line of echoes) expect(line).toMatch(/(\| quiet|quiet <)/);

		// And the neutraliser actually neutralises, for both command forms.
		const quiet = (input: string) =>
			execFileSync("bash", ["-c", `${definition}\nprintf '%s\\n' "$1" | quiet`, "_", input], {
				encoding: "utf8",
			});
		const read = JSON.stringify({
			type: "tool_execution_update",
			output: "core.info(`##[add-matcher]${matchersPath}`);",
		});
		expect(quiet(read)).not.toContain("##[");
		expect(quiet("::set-output name=url::x").trimStart().startsWith("::")).toBe(false);
		// The runner trims leading whitespace before it looks for `::`, so
		// indenting is not a defence.
		expect(quiet("        ::error::nested").trimStart().startsWith("::")).toBe(false);
	});

	it("summarises the review with the last message that has text, not the tool call", () => {
		// `submit_review` returns `terminate: true`, so the run ends on the
		// message that calls it, which usually has no text block at all. Taking
		// the last message rather than its last text would leave the log empty on
		// exactly the success path the summary exists for.
		const review = step("Review");
		const program = (review.run ?? "").match(
			/answer=\$\(jq -Rrs '([\s\S]*?)' "\$PI_REVIEW_EVENTS"/
		)?.[1];
		expect(program).toBeTruthy();

		const events = [
			{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Reading the diff." }] } },
			{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Three findings, submitting." }] } },
			// The submit_review call: a tool call and thinking, no text.
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "Let me submit." },
						{ type: "toolCall", name: "submit_review", arguments: {} },
					],
				},
			},
		];
		const run = (lines: unknown[]) =>
			execFileSync("jq", ["-Rrs", program as string], {
				input: lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
				encoding: "utf8",
			});
		expect(run(events).trim()).toBe("Three findings, submitting.");
	});

	it("records what the run cost, summed over the model calls", () => {
		// Every `message_end` carries the usage of one model call, so the run
		// total is the sum. Nothing else reports cost: it would be in the
		// artifact, which nobody downloads to answer "was that review worth it".
		const review = step("Review");
		const program = (review.run ?? "").match(/if ! jq -Rrs '([\s\S]*?)' "\$PI_REVIEW_EVENTS" > "\$work\/usage\.json"/)?.[1];
		expect(program).toBeTruthy();

		const totals = (lines: unknown[]) =>
			JSON.parse(
				execFileSync("jq", ["-Rrs", program as string], {
					input: lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
					encoding: "utf8",
				})
			);
		const call = (fields: Record<string, number> = {}, role = "assistant") => ({
			type: "message_end",
			message: {
				role,
				content: [],
				usage: {
					input: 100,
					output: 10,
					cacheRead: 1000,
					cacheWrite: 0,
					totalTokens: 1110,
					cost: { total: 0.0001 },
					...fields,
				},
			},
		});

		// No completed message: absent, not zeroed, so "the provider said
		// nothing" and "this review was free" stay distinguishable.
		expect(totals([])).toEqual({});

		const summed = totals([call(), call({ input: 200 })]);
		expect(summed.calls).toBe(2);
		expect(summed.input).toBe(300);
		expect(summed.totalTokens).toBe(2220);
		// A tool result's usage is nested model work, which is not part of the
		// main model call.
		expect(totals([call(), call({}, "toolResult")]).calls).toBe(1);

		// The conclusion carries it, and the summary line prints it.
		const conclude = step("Conclude the review");
		expect(conclude.env?.PI_REVIEW_RUN_META).toBe("${{ runner.temp }}/pi-review/run-meta.json");
		expect(conclude.run).toContain("usage:$usage");
		// `--slurpfile` on a missing run-meta would fail the step that decides
		// the outcome, so the value is read defensively into a variable.
		expect(conclude.run).toContain('usage_json=$(jq -c \'.usage // {}\' "$run_meta"');

		// Executed, not string-matched: the first draft of this line passed the
		// object as a trailing argument, which jq read as a file name, and every
		// run printed "not reported" while a contains() assertion stayed green.
		const summaryProgram = (conclude.run ?? "").match(
			/usage_line=\$\(jq -rn --argjson usage "\$usage_json" '([\s\S]*?)' 2>\/dev\/null/
		)?.[1];
		expect(summaryProgram).toBeTruthy();
		const summaryLine = (object: unknown) =>
			execFileSync("jq", ["-rn", "--argjson", "usage", JSON.stringify(object), summaryProgram as string], {
				encoding: "utf8",
			}).trim();
		expect(summaryLine(summed)).toBe("2 call(s), 2220 tokens (300 in, 20 out, 2000 cache read) · $0.0002");
		expect(summaryLine({})).toBe("not reported");
	});

	it("writes a patient retry policy into a throwaway agent directory", () => {
		const settings = step("Read the settings");
		expect(settings.run).toContain('agent_dir="$RUNNER_TEMP/pi-review/agent"');
		expect(settings.run).toContain("maxAgentDelayMs");
		expect(settings.run).toContain("providerMaxRetries");
		expect(settings.run).toContain("maxRetryDelayMs");
		// The agent directory is a fresh settings file, not the caller's or the
		// runner user's, so no unrelated global setting can change a review.
		expect(settings.run).toContain("> \"$agent_dir/settings.json\"");
	});

	it("recovers a validated review, then a substantive prose answer", () => {
		const recover = step("Recover the review");
		expect(recover.if).toBe("always()");
		expect(recover.run).toContain(".review != null");
		expect(recover.run).toContain("recovery-full.json");
		expect(recover.run).toContain("recovery-summary.json");
		expect(recover.run).toContain("message_end");
		expect(recover.run).toContain("-ge 400");
		expect(recover.run).toContain("Submitted by recovery");
		// A provider error is not a prose review and never becomes a comment.
		expect(recover.run).toContain("provider|aborted|budget");
	});

	it("concludes once, with a distinct provider warning", () => {
		const conclude = step("Conclude the review");
		expect(conclude.if).toBe("always()");
		expect(conclude.run).toContain("PI_REVIEW_ON_PROVIDER_FAILURE");
		expect(conclude.run).toContain("provider-warn");
		expect(conclude.run).toContain("::error::pi-review could not post a review");
		expect(conclude.run).toContain("$GITHUB_STEP_SUMMARY");
	});

	it("edits one failure comment in place with the workflow token", () => {
		const report = step("Report or clear an incomplete review");
		expect(report.if).toBe("always() && !cancelled()");
		// A cancelled run is a superseded review, not a failure worth reporting.
		expect(report.run).toContain("--method DELETE");
		expect(report.run).toContain("success|recovered");
		expect(report.env?.GH_TOKEN).toBe("${{ github.token }}");
		expect(report.run).toContain("<!-- pi-review:failed -->");
		expect(report.run).toContain("github-actions[bot]");
		expect(report.run).toContain("--method PATCH");
		expect(report.run).toContain("actions/runs/${GITHUB_RUN_ID}");
	});

	it("uploads the transcript and the resolved run state", () => {
		const upload = step("Upload the review transcript");
		expect(upload.if).toBe("always()");
		expect(upload.uses).toBe("actions/upload-artifact@v7");
		expect(upload.with?.["if-no-files-found"]).toBe("warn");
		expect(String(upload.with?.path)).toContain("events.jsonl");
		expect(String(upload.with?.path)).toContain("run-meta.json");
		expect(String(upload.with?.path)).toContain("conclusion.json");
		// Never upload the installed pi prefix; it is large and not the transcript.
		expect(String(upload.with?.path)).not.toContain("pi-review/pi");
	});

	it("names the file the callers point at", () => {
		expect(REUSABLE_WORKFLOW_PATH).toBe(".github/workflows/pi-review-reusable.yml");
		expect(REUSABLE_REF).toBe("main");
	});
});
