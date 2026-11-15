/**
 * How a dry run reads on a terminal.
 *
 * The same shape the comment will use later, so phase 0 is an honest preview
 * rather than a second format to learn: what it applied and why, what it
 * refused and why, what it set aside.
 */

import type { Issue } from "./github.ts";
import type { Proposal } from "./proposal.ts";

function pad(value: string, width: number): string {
	return value.length >= width ? value : value + " ".repeat(width - value.length);
}

export function formatReport(issue: Issue, proposal: Proposal): string {
	const lines: string[] = [];
	lines.push(`#${issue.number}  ${issue.title}`);
	lines.push(
		`labels now: ${issue.labels.length > 0 ? issue.labels.join(", ") : "(none)"}`
	);
	lines.push("");

	if (proposal.applied.length > 0) {
		const width = Math.max(...proposal.applied.map((entry) => entry.name.length));
		for (const entry of proposal.applied) {
			lines.push(`  + ${pad(entry.name, width)}  ${entry.why}`);
		}
	} else {
		lines.push("  + nothing applied");
	}

	if (proposal.removed.length > 0) {
		const width = Math.max(...proposal.removed.map((entry) => entry.name.length));
		for (const entry of proposal.removed) {
			lines.push(`  - ${pad(entry.name, width)}  ${entry.why}`);
		}
	}

	const quiet = [...proposal.rejected, ...proposal.leftInPlace];
	if (quiet.length > 0) {
		lines.push("");
		for (const entry of proposal.rejected) {
			lines.push(`  x ${entry.name}  ${entry.reason}`);
		}
		for (const entry of proposal.leftInPlace) {
			lines.push(`  = ${entry.name}  left in place: ${entry.reason}`);
		}
	}

	const considered = proposal.considered.filter((entry) => entry.whyNot);
	if (considered.length > 0) {
		lines.push("");
		for (const entry of considered) {
			lines.push(`  · ${entry.name}  ${entry.whyNot}`);
		}
	}

	return lines.join("\n");
}

export interface JsonReport {
	issue: { number: number; title: string; labels: string[]; url?: string };
	proposal: Proposal;
}

export function jsonReport(issue: Issue, proposal: Proposal): JsonReport {
	return {
		issue: { number: issue.number, title: issue.title, labels: issue.labels, url: issue.url },
		proposal,
	};
}
