/**
 * Re-pin the pi-review package ref and regenerate the workflow.
 *
 *   pnpm pi-review:pin            # pin to the current HEAD commit
 *   pnpm pi-review:pin <sha|tag>  # pin to a specific ref
 *   pnpm pi-review:pin --check    # fail if the workflow is out of date
 *
 * Reads `.github/pi-review.json`, updates `pi.packageRef`, and rewrites both the
 * settings file and `.github/workflows/pi-review.yml`. No other setting changes.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { SETTINGS_PATH, WORKFLOW_PATH, parseSettings, renderSettings } from "./settings.ts";
import { renderWorkflow } from "./workflow.ts";

const args = process.argv.slice(2);
const check = args.includes("--check");
const requested = args.find((arg) => !arg.startsWith("--"));

const current = parseSettings(JSON.parse(readFileSync(SETTINGS_PATH, "utf8")));
const ref = requested ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const settings = check ? current : { ...current, pi: { ...current.pi, packageRef: ref } };

const files = [
	[SETTINGS_PATH, renderSettings(settings)],
	[WORKFLOW_PATH, renderWorkflow(settings)],
] as const;

if (check) {
	const stale = files.filter(([path, content]) => readFileSync(path, "utf8") !== content);
	if (stale.length > 0) {
		console.error(`Out of date: ${stale.map(([path]) => path).join(", ")}. Run pnpm pi-review:pin.`);
		process.exit(1);
	}
	console.log(`pi-review workflow is up to date (packageRef ${current.pi.packageRef}).`);
} else {
	for (const [path, content] of files) writeFileSync(path, content, "utf8");
	console.log(`Pinned pi-review to ${ref}; rewrote ${files.map(([path]) => path).join(" and ")}.`);
	console.log("The ref must be pushed and reachable on GitHub before the workflow can fetch it. Commit both files.");
}
