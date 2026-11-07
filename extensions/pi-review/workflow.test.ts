import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { defaultSettings, type ReviewSettings } from "./settings.ts";
import { PACKAGE_REPO, PACKAGE_SUBDIR, renderWorkflow } from "./workflow.ts";

function settings(overrides: Partial<ReviewSettings> = {}): ReviewSettings {
	const base = defaultSettings({
		provider: "opencode-go",
		model: "deepseek-v4.1-flash",
		piVersion: "1.5.0",
		packageRef: "abc123",
	});
	return { ...base, ...overrides };
}

interface Workflow {
	on: { pull_request: { types: string[]; paths?: string[] } };
	concurrency: { group: string; "cancel-in-progress": boolean };
	permissions: Record<string, string>;
	jobs: {
		review: {
			if: string;
			"timeout-minutes": number;
			steps: {
				name?: string;
				uses?: string;
				id?: string;
				run?: string;
				env?: Record<string, string>;
				if?: string;
				with?: Record<string, string>;
				"timeout-minutes"?: number;
				"continue-on-error"?: boolean;
			}[];
		};
	};
}

function render(overrides: Partial<ReviewSettings> = {}): Workflow {
	return parse(renderWorkflow(settings(overrides))) as Workflow;
}

describe("renderWorkflow", () => {
	it("renders valid YAML with the review job and its steps", () => {
		const workflow = render();
		expect(workflow.on.pull_request.types).toEqual([
			"opened",
			"synchronize",
			"ready_for_review",
			"reopened",
		]);
		expect(workflow.concurrency).toEqual({
			group: "pi-review-${{ github.event.pull_request.number }}",
			"cancel-in-progress": true,
		});
		expect(workflow.permissions).toEqual({
			contents: "read",
			"pull-requests": "write",
			issues: "write",
		});
		expect(workflow.jobs.review["timeout-minutes"]).toBe(25);
		const names = workflow.jobs.review.steps.map((step) => step.name ?? step.uses);
		expect(names).toEqual([
			"actions/checkout@v4",
			"actions/setup-node@v4",
			"Install pi",
			"Check out pi-review",
			"Mint the App token",
			"Review",
			"Step summary",
			"Report an incomplete review",
		]);
	});

	it("pins pi and the package ref, and checks out the PR with history", () => {
		const workflow = render();
		const text = JSON.stringify(workflow.jobs.review.steps);
		expect(text).toContain("@earendil-works/pi-coding-agent@1.5.0");
		expect(text).toContain("fetch --depth 1 origin 'abc123'");
		expect(text).toContain(PACKAGE_REPO);
		expect(text).toContain(`${PACKAGE_SUBDIR}/index.ts`);
		expect(workflow.jobs.review.steps[0]).toMatchObject({
			uses: "actions/checkout@v4",
			with: { "fetch-depth": 0, "persist-credentials": false },
		});
	});

	it("runs the review with the configured model, tools, and env", () => {
		const workflow = render({
			tools: { bash: true },
			review: { ...settings().review, event: "REQUEST_CHANGES", maxInlineComments: 40 },
		});
		const review = workflow.jobs.review.steps.find((step) => step.name === "Review")!;
		expect(review["timeout-minutes"]).toBe(20);
		expect(review.run).toContain('--tools read,grep,find,ls,bash,submit_review');
		expect(review.run).toContain("--provider opencode-go");
		expect(review.run).toContain("--model deepseek-v4.1-flash");
		expect(review.run).toContain("--thinking medium");
		expect(review.run).toContain('"Review pull request #$PR_NUMBER."');
		expect(review.run).toContain("set -euo pipefail");
		expect(review.run).toContain("wrote no review artifact");
		expect(review.run).toContain("finished without submitting a review");
		expect(review.env).toMatchObject({
			PI_REVIEW: "1",
			PR_NUMBER: "${{ github.event.pull_request.number }}",
			OPENCODE_API_KEY: "${{ secrets.PI_REVIEW_API_KEY }}",
			PI_REVIEW_MAX_COMMENTS: "40",
			PI_REVIEW_REQUEST_CHANGES: "1",
			PI_REVIEW_STRICTNESS: "significant",
		});
	});

	it("installs dependencies and exports the outcome when verify is on", () => {
		const workflow = render({
			tools: { bash: true },
			verify: { installDependencies: true, installCommand: "" },
		});
		const names = workflow.jobs.review.steps.map((step) => step.name ?? step.uses);
		expect(names).toContain("Restore the dependency cache");
		expect(names).toContain("Install dependencies");
		const cache = workflow.jobs.review.steps.find((step) => step.uses === "actions/cache@v4")!;
		expect(cache.with?.key).toContain("hashFiles");
		const install = workflow.jobs.review.steps.find((step) => step.name === "Install dependencies")!;
		expect(install["continue-on-error"]).toBe(true);
		expect(install.run).toContain("PI_REVIEW_DEPS=unavailable");
		expect(install.run).toContain("PI_REVIEW_DEPS=installed");
		expect(install.run).toContain("corepack pnpm install --frozen-lockfile");
		expect(install.run).toContain("npm ci");
		// Classic Yarn ignores --immutable; branch on the major version.
		expect(install.run).toContain("corepack yarn --version");
		expect(install.run).toContain("corepack yarn install --frozen-lockfile");
		expect(install.run).toContain("corepack yarn install --immutable");
		// Node managers are exclusive; a second Node lockfile must not run a
		// second installer (npm ci would delete what pnpm/yarn installed).
		expect(install.run).toContain("elif [ -f package-lock.json ]");
		expect(install.run).toContain("elif [ -f yarn.lock ]");
		expect(install.run).toContain("elif [ -f bun.lock ]");
		// Non-Node ecosystems are detected too.
		expect(install.run).toContain("uv sync --frozen");
		expect(install.run).toContain("python3 -m pip install -r requirements.txt");
		expect(install.run).toContain("go mod download");
		expect(install.run).toContain("cargo fetch");
		expect(install.run).toContain("bundle install");
		expect(install.run).toContain("dotnet restore");
		// The cache covers their stores as well.
		expect(cache.with?.path).toContain("~/go/pkg/mod");
		expect(cache.with?.path).toContain("~/.cargo/registry");
		expect(cache.with?.key).toContain("go.sum");
		// The job budget covers the install step on top of the review.
		expect(workflow.jobs.review["timeout-minutes"]).toBe(33);
	});

	it("runs a custom install command instead of detection", () => {
		const workflow = render({
			tools: { bash: true },
			verify: { installDependencies: true, installCommand: "make deps\nmake fixtures" },
		});
		const install = workflow.jobs.review.steps.find((step) => step.name === "Install dependencies")!;
		expect(install.run).toContain("make deps\nmake fixtures");
		expect(install.run).not.toContain("pnpm-lock.yaml");
		expect(install.run).toContain("PI_REVIEW_DEPS=installed");
	});

	it("skips the dependency steps when verify is off or bash is disabled", () => {
		const off = render().jobs.review.steps.map((step) => step.name ?? step.uses);
		expect(off).not.toContain("Install dependencies");
		const noBash = render({
			tools: { bash: false },
			verify: { installDependencies: true, installCommand: "" },
		});
		expect(noBash.jobs.review.steps.map((step) => step.name ?? step.uses)).not.toContain(
			"Install dependencies"
		);
	});

	it("passes the configured strictness", () => {
		const workflow = render({ review: { ...settings().review, strictness: "thorough" } });
		const review = workflow.jobs.review.steps.find((step) => step.name === "Review")!;
		expect(review.env?.PI_REVIEW_STRICTNESS).toBe("thorough");
	});

	it("uses the GITHUB_TOKEN fallback without the App step", () => {
		const workflow = render({ identity: "token" });
		const names = workflow.jobs.review.steps.map((step) => step.name ?? step.uses);
		expect(names).not.toContain("Mint the App token");
		const review = workflow.jobs.review.steps.find((step) => step.name === "Review")!;
		expect(review.env?.GH_TOKEN).toBe("${{ steps.app-token.outputs.token || github.token }}");
	});

	it("filters paths with a single list of negations when excludes are set", () => {
		expect(render({ paths: { include: ["src/**"], exclude: ["**/*.md"] } }).on.pull_request.paths).toEqual([
			"src/**",
			"!**/*.md",
		]);
		expect(render({ paths: { include: [], exclude: ["docs/**"] } }).on.pull_request.paths).toEqual([
			"**",
			"!docs/**",
		]);
		expect(render({ paths: { include: [], exclude: [] } }).on.pull_request.paths).toBeUndefined();
	});

	it("adds skip conditions for drafts and bots", () => {
		expect(render().jobs.review.if).toContain("github.event.pull_request.draft == false");
		expect(render().jobs.review.if).not.toContain("Bot");
		expect(render({ triggers: { ...settings().triggers, skipBots: true } }).jobs.review.if).toContain(
			"github.event.pull_request.user.type != 'Bot'"
		);
		expect(render({ triggers: { ...settings().triggers, skipDrafts: false } }).jobs.review.if).not.toContain(
			"draft"
		);
	});

	it("always skips fork pull requests", () => {
		expect(render().jobs.review.if).toContain(
			"github.event.pull_request.head.repo.full_name == github.repository"
		);
	});

	it("reports an incomplete review on failure and summarizes the artifact", () => {
		const steps = render().jobs.review.steps;
		const summary = steps.find((step) => step.name === "Step summary")!;
		expect(summary.if).toBe("always()");
		expect(summary.run).toContain("$GITHUB_STEP_SUMMARY");
		expect(summary.run).toContain("incomplete");
		const failure = steps.find((step) => step.name === "Report an incomplete review")!;
		expect(failure.if).toBe("failure()");
		expect(failure.run).toContain("gh pr comment");
		expect(failure.run).toContain('"incomplete": true');
	});

	it("omits the provider key env when the provider env is unknown", () => {
		const workflow = render({ provider: "custom", providerEnv: "" });
		const review = workflow.jobs.review.steps.find((step) => step.name === "Review")!;
		expect(Object.keys(review.env ?? {})).not.toContain("OPENCODE_API_KEY");
		expect(review.run).toContain("--provider custom");
	});

	it("is deterministic", () => {
		expect(renderWorkflow(settings())).toBe(renderWorkflow(settings()));
	});
});
