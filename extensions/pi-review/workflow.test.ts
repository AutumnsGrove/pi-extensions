import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { defaultSettings, type ReviewSettings } from "./settings.ts";
import {
	INSTALL_BUDGET_MINUTES,
	PACKAGE_REPO,
	REUSABLE_WORKFLOW_PATH,
	renderWorkflow,
} from "./workflow.ts";

function settings(overrides: Partial<ReviewSettings> = {}): ReviewSettings {
	const base = defaultSettings({
		provider: "opencode-go",
		model: "deepseek-v4.1-flash",
		piVersion: "1.5.0",
	});
	return { ...base, ...overrides };
}

interface Caller {
	on: {
		pull_request: { types: string[]; paths?: string[] };
		issue_comment?: { types: string[] };
	};
	concurrency: { group: string; "cancel-in-progress": boolean };
	permissions: Record<string, string>;
	jobs: {
		review: {
			if: string;
			uses: string;
			with: Record<string, string | number | boolean>;
			secrets: string;
		};
	};
}

function render(overrides: Partial<ReviewSettings> = {}): Caller {
	return parse(renderWorkflow(settings(overrides))) as Caller;
}

describe("renderWorkflow", () => {
	it("renders a caller for the reusable workflow and nothing else", () => {
		const workflow = render();
		expect(workflow.jobs.review.uses).toBe(`${PACKAGE_REPO}/${REUSABLE_WORKFLOW_PATH}@main`);
		expect(workflow.jobs.review.secrets).toBe("inherit");
		// The job body is not copied here any more: that was the whole problem in
		// issue #34. A caller has no steps of its own.
		expect(workflow.jobs.review).not.toHaveProperty("steps");
		expect(workflow.jobs.review).not.toHaveProperty("runs-on");
		expect(workflow.on.pull_request.types).toEqual([
			"opened",
			"synchronize",
			"ready_for_review",
			"reopened",
		]);
		expect(workflow.concurrency["cancel-in-progress"]).toBe(true);
		expect(workflow.permissions).toEqual({
			contents: "read",
			"pull-requests": "write",
			issues: "write",
		});
	});

	it("hands the timeouts and the settings path to the reusable job", () => {
		const workflow = render();
		expect(workflow.jobs.review.with).toEqual({
			"settings-path": ".github/pi-review.json",
			"review-timeout-minutes": 20,
			"job-timeout-minutes": 25,
			"install-dependencies": false,
		});
	});

	it("budgets the install step into the job timeout", () => {
		const workflow = render({
			tools: { bash: true },
			verify: { installDependencies: true, installCommand: "" },
		});
		expect(workflow.jobs.review.with["install-dependencies"]).toBe(true);
		expect(workflow.jobs.review.with["job-timeout-minutes"]).toBe(20 + 5 + INSTALL_BUDGET_MINUTES);
	});

	it("passes a custom install command as a block scalar", () => {
		const workflow = render({
			tools: { bash: true },
			verify: { installDependencies: true, installCommand: "make deps\nmake fixtures" },
		});
		expect(workflow.jobs.review.with["install-command"]).toBe("make deps\nmake fixtures\n");
	});

	it("omits the install settings when verify is off or bash is disabled", () => {
		const off = render();
		expect(off.jobs.review.with).not.toHaveProperty("install-command");
		const noBash = render({ tools: { bash: false }, verify: { installDependencies: true, installCommand: "x" } });
		expect(noBash.jobs.review.with["install-dependencies"]).toBe(false);
		expect(noBash.jobs.review.with).not.toHaveProperty("install-command");
	});

	it("keeps the concurrency group and the job condition identical", () => {
		const workflow = render();
		expect(workflow.concurrency.group).toContain(`((${workflow.jobs.review.if}))`);
		expect(workflow.concurrency.group).toContain(
			"format('pi-review-{0}', github.event.pull_request.number || github.event.issue.number)"
		);
		expect(workflow.concurrency.group).toContain("format('pi-review-ignored-{0}', github.run_id)");
		expect(workflow.concurrency.group.match(/\$\{\{/g)).toHaveLength(1);
		expect(renderWorkflow(settings())).toContain("concurrency:\n  group: >-\n    ${{ ");
	});

	it("keeps the unique-group fallback with the mention trigger off", () => {
		const workflow = render({ triggers: { ...settings().triggers, mention: false } });
		expect(workflow.concurrency.group).not.toContain("@pi");
		expect(workflow.concurrency.group).not.toContain("issue_comment");
		expect(workflow.concurrency.group).toContain("format('pi-review-ignored-{0}', github.run_id)");
		expect(workflow.on.issue_comment).toBeUndefined();
		expect(workflow.jobs.review.if).not.toContain("@pi");
	});

	it("adds an @pi mention trigger and its guards", () => {
		const workflow = render();
		expect(workflow.on.issue_comment?.types).toEqual(["created"]);
		expect(workflow.jobs.review.if).toContain("contains(github.event.comment.body, '@pi')");
		expect(workflow.jobs.review.if).toContain("author_association");
		expect(workflow.jobs.review.if).toContain("github.event.issue.pull_request != null");
	});

	it("always skips fork pull requests", () => {
		expect(render().jobs.review.if).toContain(
			"github.event.pull_request.head.repo.full_name == github.repository"
		);
	});

	it("adds skip conditions for drafts and bots", () => {
		expect(render().jobs.review.if).toContain("github.event.pull_request.draft == false");
		expect(render().jobs.review.if).not.toContain("github.event.pull_request.user.type != 'Bot'");
		expect(render({ triggers: { ...settings().triggers, skipBots: true } }).jobs.review.if).toContain(
			"github.event.pull_request.user.type != 'Bot'"
		);
		expect(
			render({ triggers: { ...settings().triggers, skipDrafts: false } }).jobs.review.if
		).not.toContain("draft");
	});

	it("filters paths with a single list of negations when excludes are set", () => {
		expect(
			render({ paths: { include: ["src/**"], exclude: ["**/*.md"] } }).on.pull_request.paths
		).toEqual(["src/**", "!**/*.md"]);
		expect(render({ paths: { include: [], exclude: ["docs/**"] } }).on.pull_request.paths).toEqual([
			"**",
			"!docs/**",
		]);
		expect(render({ paths: { include: [], exclude: [] } }).on.pull_request.paths).toBeUndefined();
	});

	it("is deterministic", () => {
		expect(renderWorkflow(settings())).toBe(renderWorkflow(settings()));
	});
});
