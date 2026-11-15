/**
 * Regenerate the caller workflow from the committed settings, or check that it
 * is already what the settings say.
 *
 *   pnpm pi-review:sync           # rewrite .github/workflows/pi-review.yml
 *   pnpm pi-review:sync --check   # exit 1 when the file is out of date
 *
 * There is nothing to pin. The job lives in the pi-extensions repository and
 * runs from `main` (issue #34), so this only has to keep the local caller in
 * step with `.github/pi-review.json`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { SETTINGS_PATH, WORKFLOW_PATH, parseSettings } from "./settings.ts";
import { renderWorkflow } from "./workflow.ts";

const check = process.argv.slice(2).includes("--check");
const current = parseSettings(JSON.parse(readFileSync(SETTINGS_PATH, "utf8")));
const content = renderWorkflow(current);

if (check) {
	if (readFileSync(WORKFLOW_PATH, "utf8") !== content) {
		console.error(`${WORKFLOW_PATH} is out of date with ${SETTINGS_PATH}. Run pnpm pi-review:sync.`);
		process.exit(1);
	}
	console.log(`${WORKFLOW_PATH} is up to date.`);
} else {
	writeFileSync(WORKFLOW_PATH, content, "utf8");
	console.log(`Rewrote ${WORKFLOW_PATH} from ${SETTINGS_PATH}.`);
}
