import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import { formatBar, formatCountdown, formatPercent, formatUsd, type UsageMeter } from "./usage.ts";

/** The slice of the pi theme the panel needs; structurally satisfied by Theme. */
export interface PanelTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export interface UsagePanelOptions {
	meters: UsageMeter[];
	workspace?: string;
	error?: string;
	updatedAt?: number;
	theme: PanelTheme;
	done(result: undefined): void;
}

const severity = (percent: number): string => {
	if (percent >= 90) return "error";
	if (percent >= 70) return "warning";
	return "success";
};

/** Focused overlay showing the three Go meters as used-vs-limit bars. */
export class UsagePanel implements Component {
	private readonly options: UsagePanelOptions;

	constructor(options: UsagePanelOptions) {
		this.options = options;
	}

	invalidate(): void {
		// Stateless render; nothing cached.
	}

	handleInput(data: string): void {
		if (
			matchesKey(data, Key.escape) ||
			matchesKey(data, Key.enter) ||
			matchesKey(data, Key.return) ||
			matchesKey(data, "q")
		) {
			this.options.done(undefined);
		}
	}

	render(width: number): string[] {
		const { theme, meters, error, workspace, updatedAt } = this.options;
		const barWidth = Math.max(10, Math.min(28, width - 46));
		const lines: string[] = [];
		lines.push(theme.bold(theme.fg("accent", "OpenCode Go — usage")));
		if (workspace) {
			const meta = updatedAt ? `${workspace}  ·  updated ${new Date(updatedAt).toLocaleTimeString()}` : workspace;
			lines.push(theme.fg("dim", meta));
		}
		lines.push("");

		if (error) {
			lines.push(theme.fg("warning", error));
		} else if (meters.length === 0) {
			lines.push(theme.fg("muted", "No usage data yet."));
		} else {
			const now = Date.now();
			for (const meter of meters) {
				const ratio = meter.limitUsd > 0 ? meter.usedUsd / meter.limitUsd : 0;
				const color = severity(meter.percent);
				const countdown = formatCountdown(meter.resetsAt, now);
				let row = `${theme.fg("text", meter.label.padEnd(11))} ${theme.fg(color, formatBar(ratio, barWidth))}`;
				row += `  ${theme.fg(color, formatPercent(meter.percent).padStart(5))}`;
				row += `  ${theme.fg("muted", `${formatUsd(meter.usedUsd)} / ${formatUsd(meter.limitUsd)}`)}`;
				if (countdown) row += `  ${theme.fg("dim", countdown)}`;
				lines.push(row);
			}
		}

		lines.push("");
		lines.push(theme.fg("dim", "esc to close"));
		return lines;
	}
}
