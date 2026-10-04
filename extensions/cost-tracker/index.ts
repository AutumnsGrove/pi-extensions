import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	COST_END,
	COST_START,
	addUsage,
	aggregateByLabel,
	allRunsWithHistory,
	defaultLabel,
	formatDuration,
	formatTokens,
	formatUsd,
	readActive,
	readRuns,
	renderCostTable,
	startRun,
	stopRun,
	upsertCostBlock,
	zeroUsage,
} from "./ledger.ts";
import type { CostUsage } from "./ledger.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STATUS_KEY = "cost";
const USAGE =
	"Usage: /cost [start <label> | stop | status | report | export]";

interface MinimalMessage {
	role?: string;
	usage?: unknown;
	model?: string;
	provider?: string;
}

function toCostUsage(raw: unknown): CostUsage {
	const u = (raw ?? {}) as Record<string, unknown>;
	const cost = (u.cost ?? {}) as Record<string, unknown>;
	const num = (value: unknown): number =>
		typeof value === "number" && Number.isFinite(value) ? value : 0;
	return {
		input: num(u.input),
		output: num(u.output),
		cacheRead: num(u.cacheRead),
		cacheWrite: num(u.cacheWrite),
		totalTokens: num(u.totalTokens),
		cost: num(cost.total),
	};
}

/** Rewrite the README cost block from the ledger. Returns the target path. */
export function exportCostTable(cwd: string): string | undefined {
	const readme = join(cwd, "README.md");
	if (!existsSync(readme)) {
		return undefined;
	}
	const markdown = readFileSync(readme, "utf8");
	const table = renderCostTable(allRunsWithHistory());
	writeFileSync(readme, upsertCostBlock(markdown, table), "utf8");
	return readme;
}

export function hasCostMarkers(cwd: string): boolean {
	const readme = join(cwd, "README.md");
	if (!existsSync(readme)) {
		return false;
	}
	const markdown = readFileSync(readme, "utf8");
	return markdown.includes(COST_START) && markdown.includes(COST_END);
}

export default function costTracker(pi: ExtensionAPI): void {
	let live: CostUsage = zeroUsage();
	let liveStartedAt: string | undefined;

	const render = (ctx: ExtensionContext): void => {
		const active = readActive();
		if (!active) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const elapsed = liveStartedAt
			? formatDuration(Date.now() - Date.parse(liveStartedAt))
			: "";
		const parts = [
			`cost ${active.label}`,
			`${formatUsd(live.cost)}`,
			`${formatTokens(live.totalTokens)} tok`,
		];
		if (elapsed) {
			parts.push(elapsed);
		}
		ctx.ui.setStatus(STATUS_KEY, parts.join(" · "));
	};

	const syncFromDisk = (ctx: ExtensionContext): void => {
		const active = readActive();
		if (active) {
			live = zeroUsage();
			liveStartedAt = active.startedAt;
		} else {
			live = zeroUsage();
			liveStartedAt = undefined;
		}
		render(ctx);
	};

	pi.on("session_start", (_event, ctx) => {
		syncFromDisk(ctx);
	});

	pi.on("message_end", (event, ctx) => {
		if (!readActive()) {
			return;
		}
		const message = event.message as unknown as MinimalMessage;
		if (
			(message.role === "assistant" || message.role === "toolResult") &&
			message.usage
		) {
			live = addUsage(live, toCostUsage(message.usage));
			render(ctx);
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	const start = (label: string, ctx: ExtensionContext): void => {
		const sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
		const run = startRun(label.trim() || defaultLabel(ctx.cwd), ctx.cwd, sessionFile);
		live = zeroUsage();
		liveStartedAt = run.startedAt;
		ctx.ui.notify(
			`Tracking "${run.label}" from ${new Date(run.startedAt).toLocaleTimeString()}. Run /cost stop when done.`,
			"info"
		);
		render(ctx);
	};

	const stop = (ctx: ExtensionContext): void => {
		const result = stopRun();
		if (!result) {
			ctx.ui.notify("No run is active. Start one with /cost start <label>.", "warning");
			return;
		}
		live = zeroUsage();
		liveStartedAt = undefined;
		render(ctx);
		const exported = exportCostTable(ctx.cwd);
		ctx.ui.notify(
			`Run "${result.run.label}" finalized: ${formatUsd(result.run.usage.cost)} · ${formatTokens(
				result.run.usage.totalTokens
			)} tok over ${result.records} messages.${exported ? ` Table updated in ${exported}.` : " (No README.md to export to.)"}`,
			"info"
		);
	};

	const status = (ctx: ExtensionContext): void => {
		const active = readActive();
		if (!active) {
			const runs = readRuns();
			ctx.ui.notify(
				`No active run. ${runs.length} finalized run(s) in the ledger.`,
				"info"
			);
			return;
		}
		const startedMs = Date.parse(active.startedAt);
		const lines = [
			`Run: ${active.label}`,
			`Started: ${active.startedAt} (${formatDuration(Date.now() - startedMs)} ago)`,
			`Live: ${formatUsd(live.cost)} · ${formatTokens(live.totalTokens)} tok`,
			`Final on /cost stop: re-read from session files`,
		];
		ctx.ui.notify(lines.join("\n"), "info");
	};

	const report = (ctx: ExtensionContext): void => {
		const runs = allRunsWithHistory();
		const totals = aggregateByLabel(runs);
		if (totals.length === 0) {
			ctx.ui.notify("No runs recorded yet.", "info");
			return;
		}
		const lines = totals.map(
			(entry) =>
				`${entry.label.padEnd(20)} ${formatUsd(entry.usage.cost).padStart(9)}  ${formatTokens(
					entry.usage.totalTokens
				).padStart(7)}  ${entry.runs} run(s)`
		);
		ctx.ui.notify(lines.join("\n"), "info");
	};

	const runCommand = async (
		args: string,
		ctx: ExtensionCommandContext
	): Promise<void> => {
		const parts = args.trim().split(/\s+/).filter(Boolean);
		const sub = parts[0] ?? "";
		const rest = parts.slice(1).join(" ");
		switch (sub) {
			case "start":
				start(rest, ctx);
				return;
			case "stop":
				stop(ctx);
				return;
			case "status":
				status(ctx);
				return;
			case "report":
				report(ctx);
				return;
			case "export": {
				const exported = exportCostTable(ctx.cwd);
				ctx.ui.notify(
					exported
						? `Cost table written to ${exported}.`
						: "No README.md in this directory to export to.",
					exported ? "info" : "warning"
				);
				return;
			}
			default:
				ctx.ui.notify(USAGE, "info");
		}
	};

	pi.registerCommand("cost", {
		description: "Track development cost from pi session usage",
		handler: runCommand,
	});
}
