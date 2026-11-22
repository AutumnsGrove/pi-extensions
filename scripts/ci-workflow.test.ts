/**
 * The gate #51 asked for. Its value is in one flag: `--frozen-lockfile` is what
 * turns "the lockfile disagrees with package.json" into a failure instead of a
 * silent re-resolution, which is exactly how the host packages sat at 1.3.0
 * while every local `node_modules` held 1.5. A review does not compile code, so
 * nothing else here would have caught it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

interface Step {
	name?: string;
	uses?: string;
	with?: Record<string, string>;
	run?: string;
}

interface Workflow {
	on: {
		pull_request?: unknown;
		push?: { branches?: string[] };
	};
	permissions?: Record<string, string>;
	jobs: { check: { "runs-on": string; "timeout-minutes"?: number; steps: Step[] } };
}

const source = fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url));
const workflow = parse(readFileSync(source, "utf8")) as Workflow;
const steps = workflow.jobs.check.steps;
const runs = steps.map((step) => step.run ?? "");
const indexOfCommand = (pattern: RegExp) => runs.findIndex((command) => pattern.test(command));

describe("the ci workflow", () => {
	it("gates pull requests and main, read-only", () => {
		expect(workflow.on.pull_request).toBeDefined();
		expect(workflow.on.push?.branches).toEqual(["main"]);
		// A typecheck and a test suite need nothing else, and a fork's pull
		// request runs this workflow too.
		expect(workflow.permissions).toEqual({ contents: "read" });
		expect(String(workflow.jobs.check["timeout-minutes"])).not.toBe("");
	});

	it("installs with a frozen lockfile before it checks anything", () => {
		const install = indexOfCommand(/pnpm install --frozen-lockfile\b/);
		expect(install).toBeGreaterThanOrEqual(0);
		// `pnpm install` without it re-resolves and hides the drift this exists
		// for, so no step may run it bare.
		for (const command of runs) {
			expect(command).not.toMatch(/pnpm install(?! --frozen-lockfile)/);
		}
		expect(indexOfCommand(/pnpm check\b/)).toBeGreaterThan(install);
		expect(indexOfCommand(/pnpm test\b/)).toBeGreaterThan(install);
	});

	it("checks the generated files too", () => {
		// Both are checked in and both are generated: a theme edit without
		// regenerating, and a caller that no longer matches the reusable
		// workflow, are exactly the drifts a human reviewer forgets to look for.
		expect(indexOfCommand(/pnpm themes:check\b/)).toBeGreaterThanOrEqual(0);
		expect(indexOfCommand(/pnpm pi-review:sync --check\b/)).toBeGreaterThanOrEqual(0);
	});

	it("runs the node version the package asks for", () => {
		const setup = steps.find((step) => step.uses?.startsWith("actions/setup-node@"));
		expect(setup?.with?.["node-version"]).toBe("22");
	});
});
