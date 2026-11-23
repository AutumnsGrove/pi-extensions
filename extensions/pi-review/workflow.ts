/**
 * Generate `.github/workflows/pi-review.yml` from the committed settings.
 *
 * The generated file is a caller, not the job. The job itself lives once, in
 * `AutumnsGrove/pi-extensions/.github/workflows/pi-review-reusable.yml`, and
 * every project calls it at `@main`, so a fix there reaches an installed
 * project without a commit in that project (decision in issue #34). What the
 * caller decides is what GitHub has to know before the job starts: the
 * triggers, the path filter, the concurrency group, the permissions, and the
 * condition under which a run actually reviews something. Everything else is
 * read from `.github/pi-review.json` by the reusable workflow at run time, so
 * model, provider, tools, limits and the review's shape stay local.
 *
 * No YAML library: the extension must run from a bare git checkout in CI where
 * this package's `node_modules` is not installed.
 */

import { type ReviewSettings, type SkipBots, WORKFLOW_PATH } from "./settings.ts";

export const PACKAGE_REPO = "AutumnsGrove/pi-extensions";
export const REUSABLE_WORKFLOW_PATH = ".github/workflows/pi-review-reusable.yml";
/** Where a project's copy of the reusable workflow points. */
export const REUSABLE_REF = "main";
export const EXTENSION_NAME = "pi-review";

/** The pull request a run is about, whichever event started it. */
const PR_NUMBER = "github.event.pull_request.number || github.event.issue.number";

/** Time reserved for the dependency install step inside the reusable job. */
export const INSTALL_BUDGET_MINUTES = 8;

function quote(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The condition that keeps a bot-authored pull request from reviewing.
 *
 * `true` refuses every bot; a list refuses only those logins, so a repository
 * can skip Dependabot and still review its own App's pull requests (#88).
 * `parseSettings` has already refused anything that is not a login, so the list
 * cannot break out of the expression or the YAML scalar it sits in.
 */
export function botCondition(skipBots: SkipBots): string | undefined {
	if (skipBots === true) return "github.event.pull_request.user.type != 'Bot'";
	if (skipBots === false || skipBots.length === 0) return undefined;
	return `!contains(fromJSON('${JSON.stringify(skipBots)}'), github.event.pull_request.user.login)`;
}

/**
 * The condition under which a run actually reviews something. The job `if:` and
 * the concurrency group share it deliberately: GitHub evaluates `concurrency`
 * when the run is created, *before* the job `if:`, so a run that will be skipped
 * must not join the pull request's group or it cancels the review in flight.
 */
export function reviewCondition(settings: ReviewSettings): string {
	const pullRequest = [
		settings.triggers.skipDrafts ? "github.event.pull_request.draft == false" : undefined,
		"github.event.pull_request.head.repo.full_name == github.repository",
		botCondition(settings.triggers.skipBots),
	]
		.filter((part): part is string => part !== undefined)
		.join(" && ");

	const conditions = [`(${pullRequest})`];
	if (settings.triggers.mention) {
		conditions.push(
			`(github.event_name == 'issue_comment' && github.event.issue.pull_request != null && contains(github.event.comment.body, '@pi') && contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association) && github.event.comment.user.type != 'Bot')`
		);
	}
	return conditions.join(" || ");
}

/**
 * One group per pull request for runs that review; a unique group for runs that
 * will be skipped, so an ordinary comment (or a draft push, or a fork) cancels
 * nothing. `github.run_id` is the documented unique fallback: the group name is
 * unique per run, so the run waits behind nothing and displaces nothing.
 *
 * Returned as lines so the workflow can render it as a folded scalar: the
 * expression is long, and folding keeps it one string (and the committed YAML
 * readable) without escaping the quotes inside it.
 */
export function concurrencyGroup(settings: ReviewSettings): string[] {
	return [
		`\${{ ((${reviewCondition(settings)}))`,
		`&& format('${EXTENSION_NAME}-{0}', ${PR_NUMBER})`,
		`|| format('${EXTENSION_NAME}-ignored-{0}', github.run_id) }}`,
	];
}

/** The `with:` block handed to the reusable workflow. */
function withLines(settings: ReviewSettings): string[] {
	const verifyDeps = settings.tools.bash && settings.verify.installDependencies;
	const lines = [
		"    with:",
		`      settings-path: ${quote(".github/pi-review.json")}`,
		`      review-timeout-minutes: ${settings.timeoutMinutes}`,
		`      job-timeout-minutes: ${settings.timeoutMinutes + 5 + (verifyDeps ? INSTALL_BUDGET_MINUTES : 0)}`,
		`      install-dependencies: ${verifyDeps}`,
	];
	if (verifyDeps && settings.verify.installCommand) {
		lines.push(
			"      install-command: |",
			...settings.verify.installCommand.split("\n").map((line) => `        ${line}`)
		);
	}
	return lines;
}

/** Render the workflow YAML. Deterministic: same settings, same bytes. */
export function renderWorkflow(settings: ReviewSettings): string {
	const trigger = settings.triggers.types.join(", ");
	// GitHub rejects `paths` and `paths-ignore` on the same event, so excludes
	// become negation patterns in a single list.
	const include =
		settings.paths.include.length > 0
			? settings.paths.include
			: settings.paths.exclude.length > 0
				? ["**"]
				: [];
	const pathPatterns = [...include, ...settings.paths.exclude.map((pattern) => `!${pattern}`)];
	const paths: string[] =
		pathPatterns.length > 0
			? ["    paths:", ...pathPatterns.map((pattern) => `      - ${quote(pattern)}`)]
			: [];

	const lines = [
		`# Generated by ${EXTENSION_NAME} from .github/pi-review.json`,
		"# Edit the settings file, not this workflow. The job lives once, in",
		`# ${PACKAGE_REPO}/${REUSABLE_WORKFLOW_PATH}, and runs from @${REUSABLE_REF},`,
		"# so a fix there reaches this repository without a commit here.",
		`name: ${EXTENSION_NAME}`,
		"",
		"on:",
		"  pull_request:",
		`    types: [${trigger}]`,
		...paths,
		...(settings.triggers.mention ? ["  issue_comment:", "    types: [created]"] : []),
		"",
		"concurrency:",
		"  group: >-",
		...concurrencyGroup(settings).map((line) => `    ${line}`),
		"  cancel-in-progress: true",
		"",
		"permissions:",
		"  contents: read",
		"  pull-requests: write",
		"  issues: write",
		"",
		"jobs:",
		"  review:",
		`    if: ${reviewCondition(settings)}`,
		`    uses: ${PACKAGE_REPO}/${REUSABLE_WORKFLOW_PATH}@${REUSABLE_REF}`,
		...withLines(settings),
		// The reusable workflow declares the App secrets it may use; inherit is
		// what lets a project keep owning the credential instead of copying it.
		"    secrets: inherit",
		"",
	];
	return lines.join("\n");
}

export function workflowPath(): string {
	return WORKFLOW_PATH;
}
