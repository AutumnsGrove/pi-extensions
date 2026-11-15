import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { generateWorkflow } from "./workflow.ts";
import { DEFAULT_SETTINGS, parseSettings } from "./settings.ts";

const workflow = generateWorkflow({ settings: DEFAULT_SETTINGS, ref: "abc123" });

interface Step {
	name?: string;
	id?: string;
	uses?: string;
	if?: string;
	run?: string;
	env?: Record<string, string>;
	with?: Record<string, string>;
}
interface Job {
	if?: string;
	needs?: string;
	concurrency?: { group: string; "cancel-in-progress": boolean };
	timeout?: number;
	outputs?: Record<string, string>;
	steps?: Step[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const parsed = parse(workflow) as any;
const jobs = parsed.jobs as Record<string, Job>;

describe("the generated workflow", () => {
	it("is valid YAML with a document start and one trailing newline", () => {
		expect(workflow.startsWith("---\n")).toBe(true);
		expect(workflow.endsWith("\n")).toBe(true);
		expect(workflow.endsWith("\n\n")).toBe(false);
		expect(() => parse(workflow)).not.toThrow();
	});

	it("fits the target repository's yamllint line length", () => {
		const long = workflow.split("\n").filter((line) => line.length > 100);
		expect(long).toEqual([]);
	});

	it("has no trailing whitespace and no double blank lines", () => {
		expect(workflow.split("\n").filter((line) => line !== line.trimEnd())).toEqual([]);
		expect(workflow.includes("\n\n\n")).toBe(false);
	});

	it("is deterministic", () => {
		expect(generateWorkflow({ settings: DEFAULT_SETTINGS, ref: "abc123" })).toBe(workflow);
	});

	it("regenerating from the same settings gives the same bytes", () => {
		const settings = parseSettings({ version: 1, model: "deepseek-v4.1-flash" });
		const first = generateWorkflow({ settings, ref: "sha" });
		const second = generateWorkflow({ settings: parseSettings({ version: 1, model: "deepseek-v4.1-flash" }), ref: "sha" });
		expect(first).toBe(second);
		expect(first).not.toBe(workflow);
	});

	it("triggers on an opened issue, a comment, and a manual run", () => {
		expect(parsed.on.issues.types).toEqual(["opened"]);
		expect(parsed.on.issue_comment.types).toEqual(["created"]);
		expect(parsed.on.workflow_dispatch.inputs.issue_number.required).toBe(true);
		expect(parsed.on.workflow_dispatch.inputs.dry_run.default).toBe(true);
	});

	it("asks for nothing beyond reading the code and writing issues", () => {
		expect(parsed.permissions).toEqual({ contents: "read", issues: "write" });
	});

	it("keeps the cheap trigger guard cheap", () => {
		expect(jobs.gate?.if).toContain("github.event.issue.pull_request == null");
		expect(jobs.gate?.if).toContain("github.event.comment.user.type != 'Bot'");
		expect(jobs.gate?.if).toContain("contains(github.event.comment.body, '@pi')");
	});

	it("puts the expensive job behind the gate", () => {
		expect(jobs.label?.needs).toBe("gate");
		expect(jobs.label?.if).toBe("needs.gate.outputs.run == 'true'");
	});

	it("cancels on the issue, not on the run", () => {
		expect(jobs.label?.concurrency).toEqual({
			group: "pi-tag-${{ needs.gate.outputs.issue }}",
			"cancel-in-progress": true,
		});
	});

	it("never refers to a step that only exists in the other job", () => {
		const gateRuns = (jobs.gate?.steps ?? []).map((step) => `${step.run ?? ""}${JSON.stringify(step.env ?? {})}`).join("\n");
		expect(gateRuns).not.toContain("steps.app-token");
		expect(gateRuns).toContain("vars.PI_TAG_APP_SLUG");
	});

	it("runs the gate decision in code, not in YAML", () => {
		const gateStep = jobs.gate?.steps?.find((step) => step.id === "gate");
		expect(gateStep?.run).toContain("gate-cli.ts");
	});

	it("checks out the tool at a pinned ref", () => {
		const runs = (jobs.label?.steps ?? []).map((step) => step.run ?? "").join("\n");
		expect(runs).toContain("fetch --depth 1 origin 'abc123'");
	});

	it("installs the pinned pi", () => {
		const runs = (jobs.label?.steps ?? []).map((step) => step.run ?? "").join("\n");
		expect(runs).toContain("@earendil-works/pi-coding-agent@1.5.2");
	});

	it("mints an App token with the App identity", () => {
		const use = (jobs.label?.steps ?? []).find((step) => step.id === "app-token");
		expect(use?.uses).toBe("actions/create-github-app-token@v1");
		expect(use?.with).toMatchObject({ "app-id": "${{ secrets.PI_TAG_APP_ID }}" });
		const tag = (jobs.label?.steps ?? []).find((step) => step.id === "tag");
		expect(tag?.env?.GH_TOKEN).toBe("${{ steps.app-token.outputs.token }}");
	});

	it("falls back to the workflow token with the token identity", () => {
		const token = generateWorkflow({ settings: parseSettings({ version: 1, identity: "token" }), ref: "r" });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const other = parse(token) as any;
		const steps = other.jobs.label.steps as Step[];
		expect(steps.find((step) => step.id === "app-token")).toBeUndefined();
		expect(steps.find((step) => step.id === "tag")?.env?.GH_TOKEN).toBe("${{ github.token }}");
		expect(token).toContain("github-actions[bot]");
	});

	it("writes nothing unless the run is not a dry run", () => {
		const tag = (jobs.label?.steps ?? []).find((step) => step.id === "tag")?.run ?? "";
		expect(tag).toContain('if [ "$DRY_RUN" != "true" ]; then');
		expect(tag).toContain("--apply");
	});

	it("passes a fix note only when the gate called it a fix", () => {
		const tag = (jobs.label?.steps ?? []).find((step) => step.id === "tag")?.run ?? "";
		expect(tag).toContain('if [ "$IS_FIX" = "true" ]; then');
		expect(tag).toContain('args+=(--fix "$NOTE")');
		expect(tag).toContain('args+=(--note "$NOTE")');
	});

	it("reports a job that dies before it can comment", () => {
		const report = (jobs.label?.steps ?? []).find((step) => step.name === "Report a run that never finished");
		expect(report?.if).toContain("failure()");
		expect(report?.run).toContain("gh issue comment");
	});

	it("follows the settings it was given", () => {
		const custom = generateWorkflow({
			settings: parseSettings({
				version: 1,
				triggers: { mention: "@grove" },
				timeoutMinutes: 12,
				pi: { version: "1.6.0" },
			}),
			ref: "r",
		});
		expect(custom).toContain("contains(github.event.comment.body, '@grove')");
		expect(custom).toContain("timeout-minutes: 16");
		expect(custom).toContain("@earendil-works/pi-coding-agent@1.6.0");
	});

	it("keeps the note output as a heredoc so multi-line notes survive", () => {
		expect(jobs.gate?.outputs?.note).toBe("${{ steps.gate.outputs.note }}");
	});
});
