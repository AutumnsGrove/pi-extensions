/**
 * Generate `.github/workflows/pi-review.yml` from the committed settings.
 *
 * The workflow is deliberately thin: it checks out the PR with full history,
 * installs a pinned pi, fetches this package at a pinned ref, mints the review
 * identity (App token or `GITHUB_TOKEN`), runs one headless pi with the review
 * extension, and reports the result. Everything policy-shaped lives in
 * `.github/pi-review.json`, so regenerating this file from settings is safe.
 *
 * No YAML library: the extension must run from a bare git checkout in CI where
 * this package's `node_modules` is not installed.
 */

import { type ReviewSettings, WORKFLOW_PATH } from "./settings.ts";

export const PACKAGE_REPO = "https://github.com/AutumnsGrove/pi-extensions.git";
export const PACKAGE_SUBDIR = "extensions/pi-review";
export const EXTENSION_NAME = "pi-review";

function quote(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function toolList(settings: ReviewSettings): string {
	const tools = ["read", "grep", "find", "ls"];
	if (settings.tools.bash) tools.push("bash");
	tools.push("submit_review");
	return tools.join(",");
}

function jobCondition(settings: ReviewSettings): string {
	const parts = [
		settings.triggers.skipDrafts ? "github.event.pull_request.draft == false" : undefined,
		"github.event.pull_request.head.repo.full_name == github.repository",
		settings.triggers.skipBots ? "github.event.pull_request.user.type != 'Bot'" : undefined,
	].filter((part): part is string => part !== undefined);
	return parts.join(" && ");
}

/** Render the workflow YAML. Deterministic: same settings, same bytes. */
export function renderWorkflow(settings: ReviewSettings): string {
	const trigger = settings.triggers.types.join(", ");
	// GitHub rejects `paths` and `paths-ignore` on the same event, so excludes
	// become negation patterns in a single list.
	const include = settings.paths.include.length > 0 ? settings.paths.include : settings.paths.exclude.length > 0 ? ["**"] : [];
	const pathPatterns = [...include, ...settings.paths.exclude.map((pattern) => `!${pattern}`)];
	const paths: string[] =
		pathPatterns.length > 0
			? ["    paths:", ...pathPatterns.map((pattern) => `      - ${quote(pattern)}`)]
			: [];

	const piArgs = [
		"-p",
		"--mode json",
		"--no-session",
		"-na",
		"-nc",
		"--offline",
		"-ne",
		`-e "$RUNNER_TEMP/pi-review-src/${PACKAGE_SUBDIR}/index.ts"`,
		"-ns",
		"-np",
		"--no-themes",
		"--no-mcp",
		`--tools ${toolList(settings)}`,
		...(settings.provider ? [`--provider ${settings.provider}`] : []),
		...(settings.model ? [`--model ${settings.model}`] : []),
		`--thinking ${settings.thinking}`,
	];

	const envLines = [
		'          PI_REVIEW: "1"',
		"          PR_NUMBER: ${{ github.event.pull_request.number }}",
		'          GH_TOKEN: ${{ steps.app-token.outputs.token || github.token }}',
	];
	if (settings.providerEnv) {
		envLines.push(`          ${settings.providerEnv}: \${{ secrets.PI_REVIEW_API_KEY }}`);
	}
	envLines.push(
		"          PI_REVIEW_OUTPUT: ${{ runner.temp }}/pi-review/review.json",
		`          PI_REVIEW_MAX_COMMENTS: "${settings.review.maxInlineComments}"`,
		`          PI_REVIEW_REQUEST_CHANGES: "${settings.review.event === "REQUEST_CHANGES" ? "1" : "0"}"`
	);

	const tokenStep =
		settings.identity === "app"
			? `      - name: Mint the App token
        id: app-token
        uses: actions/create-github-app-token@v1
        with:
          app-id: \${{ secrets.PI_REVIEW_APP_ID }}
          private-key: \${{ secrets.PI_REVIEW_APP_PRIVATE_KEY }}
`
			: "";

	const reviewCommand = [
		"          pi \\",
		...piArgs.map((arg) => `            ${arg} \\`),
	].join("\n");

	const verifyDeps = settings.tools.bash && settings.verify.installDependencies;
	/** Time reserved for the dependency install step. */
	const installBudgetMinutes = 8;
	const dependencySteps = verifyDeps
		? [
				"      - name: Restore the dependency cache",
				"        uses: actions/cache@v4",
				"        with:",
				"          path: |",
				"            ~/.npm",
				"            ~/.local/share/pnpm/store",
				`          key: ${EXTENSION_NAME}-deps-\${{ runner.os }}-\${{ hashFiles('pnpm-lock.yaml', 'package-lock.json', 'yarn.lock') }}`,
				"          restore-keys: |",
				`            ${EXTENSION_NAME}-deps-\${{ runner.os }}-`,
				"      - name: Install dependencies",
				"        id: deps",
				"        continue-on-error: true",
				`        timeout-minutes: ${installBudgetMinutes}`,
				"        run: |",
				"          set -euo pipefail",
				'          echo "PI_REVIEW_DEPS=unavailable" >> "$GITHUB_ENV"',
				"          if [ -f pnpm-lock.yaml ]; then",
				"            corepack pnpm install --frozen-lockfile --prefer-offline",
				"          elif [ -f package-lock.json ]; then",
				"            npm ci --prefer-offline --no-audit --no-fund",
				"          elif [ -f yarn.lock ]; then",
				"            if corepack yarn --version | grep -q '^1\\.'; then",
				"              corepack yarn install --frozen-lockfile",
				"            else",
				"              corepack yarn install --immutable",
				"            fi",
				"          else",
				'            echo "No lockfile found; skipping dependency installation."',
				'            echo "PI_REVIEW_DEPS=none" >> "$GITHUB_ENV"',
				"            exit 0",
				"          fi",
				'          echo "PI_REVIEW_DEPS=installed" >> "$GITHUB_ENV"',
			]
		: [];

	const lines = [
		`# Generated by ${EXTENSION_NAME} from .github/pi-review.json`,
		"# Edit the settings file, not this workflow.",
		`name: ${EXTENSION_NAME}`,
		"",
		"on:",
		"  pull_request:",
		`    types: [${trigger}]`,
		...paths,
		"",
		"concurrency:",
		`  group: ${EXTENSION_NAME}-${"${{ github.event.pull_request.number }}"}`,
		"  cancel-in-progress: true",
		"",
		"permissions:",
		"  contents: read",
		"  pull-requests: write",
		"  issues: write",
		"",
		"jobs:",
		"  review:",
		`    if: ${jobCondition(settings)}`,
		"    runs-on: ubuntu-latest",
		`    timeout-minutes: ${settings.timeoutMinutes + 5 + (verifyDeps ? installBudgetMinutes : 0)}`,
		"    steps:",
		"      - uses: actions/checkout@v4",
		"        with:",
		"          fetch-depth: 0",
		"          persist-credentials: false",
		"      - uses: actions/setup-node@v4",
		"        with:",
		'          node-version: "22"',
		...dependencySteps,
		"      - name: Install pi",
		`        run: npm install -g @earendil-works/pi-coding-agent@${settings.pi.version}`,
		"      - name: Check out pi-review",
		"        run: |",
		"          set -euo pipefail",
		'          git init "$RUNNER_TEMP/pi-review-src"',
		`          git -C "$RUNNER_TEMP/pi-review-src" remote add origin ${PACKAGE_REPO}`,
		`          git -C "$RUNNER_TEMP/pi-review-src" fetch --depth 1 origin ${quote(settings.pi.packageRef)}`,
		'          git -C "$RUNNER_TEMP/pi-review-src" checkout --detach FETCH_HEAD',
		...(tokenStep ? tokenStep.replace(/\n$/, "").split("\n") : []),
		"      - name: Review",
		`        timeout-minutes: ${settings.timeoutMinutes}`,
		"        env:",
		...envLines,
		"        run: |",
		"          set -euo pipefail",
		'          mkdir -p "$(dirname "$PI_REVIEW_OUTPUT")"',
		reviewCommand,
		'            "Review pull request #$PR_NUMBER." \\',
		'            | tee "$RUNNER_TEMP/pi-review/events.jsonl"',
		'          if [ ! -f "$PI_REVIEW_OUTPUT" ]; then',
		'            echo "::error::pi-review wrote no review artifact"',
		"            exit 1",
		"          fi",
		`          if grep -q '"incomplete": true' "$PI_REVIEW_OUTPUT"; then`,
		'            echo "::error::pi-review finished without submitting a review"',
		"            exit 1",
		"          fi",
		"      - name: Step summary",
		"        if: always()",
		"        env:",
		"          PI_REVIEW_OUTPUT: ${{ runner.temp }}/pi-review/review.json",
		"        run: |",
		"          {",
		`            echo "## ${EXTENSION_NAME}"`,
		"            echo",
		'            if [ -f "$PI_REVIEW_OUTPUT" ]; then',
		`              jq -r '"**" + (.review.event // "incomplete") + "** · inline comments: " + (((.review.comments // []) | length) | tostring) + (if .url then " · " + .url else "" end) + (if .error then " · error: " + .error else "" end)' "$PI_REVIEW_OUTPUT" || echo "Unreadable artifact."`,
		"            else",
		'              echo "No review artifact: the review did not complete."',
		"            fi",
		'          } >> "$GITHUB_STEP_SUMMARY"',
		"      - name: Report an incomplete review",
		"        if: failure()",
		"        env:",
		"          GH_TOKEN: ${{ steps.app-token.outputs.token || github.token }}",
		"          PR_NUMBER: ${{ github.event.pull_request.number }}",
		"          PI_REVIEW_OUTPUT: ${{ runner.temp }}/pi-review/review.json",
		"        run: |",
		'          if [ -f "$PI_REVIEW_OUTPUT" ] && ! grep -q \'"incomplete": true\' "$PI_REVIEW_OUTPUT"; then',
		"            exit 0",
		"          fi",
		`          gh pr comment "$PR_NUMBER" --body "${EXTENSION_NAME} could not complete this review: the job failed or timed out. Fix the cause and re-run the workflow." || true`,
		"",
	];
	return lines.join("\n");
}

export function workflowPath(): string {
	return WORKFLOW_PATH;
}
