/**
 * OpenCode Go usage meters.
 *
 * The Console HTML is client-rendered, so the numbers come from the JSON API:
 *
 *   GET /api/go/status   (Authorization: Bearer <session-or-key>, x-org-id)
 *   -> { access: { startsAt, endsAt, meters: {
 *          fiveHour: { startsAt, resetsAt, limitMicroCents, usedMicroCents },
 *          week:     { startsAt, resetsAt, limitMicroCents, usedMicroCents },
 *          month:    { resetsAt, limitMicroCents, usedMicroCents } } } }
 *
 * Money is micro-cents (1e-8 USD). Percentages are used / limit. Each meter's
 * own `startsAt`/`resetsAt` bound its window (the month meter only reports
 * `resetsAt`, so it falls back to `access.startsAt`/`access.endsAt`); those
 * bounds drive both the reset countdown and the pace line.
 */

export type MeterKind = "five_hour" | "calendar_week" | "product_period";

export interface UsageMeter {
	kind: MeterKind;
	label: string;
	short: string;
	/** 0-100, clamped. */
	percent: number;
	usedUsd: number;
	limitUsd: number;
	/** ISO timestamp the window opened, or null when unknown. */
	startsAt: string | null;
	/** ISO timestamp of rollover, or null when unknown. */
	resetsAt: string | null;
}

/** Linear-budget comparison for a single meter, used by the `/usage` panel. */
export interface MeterPace {
	/** 0-100 percent of the window that has elapsed. */
	elapsedPercent: number;
	/** Used% minus the linear budget for this point in the window. */
	deltaPoints: number;
	/** Where the window lands if the current rate holds. */
	projectedPercent: number;
	status: "under" | "on" | "over";
	/** USD still available in the window. */
	remainingUsd: number;
	/** Hours left in the window (> 0). */
	remainingHours: number;
}

/** Points of drift from the linear budget that still counts as "on pace". */
const PACE_BAND_POINTS = 5;

export type UsageFailureKind =
	| "no_credentials"
	| "unauthorized"
	| "no_subscription"
	| "unrecognized"
	| "timeout"
	| "network"
	| "http";

export class UsageError extends Error {
	readonly kind: UsageFailureKind;
	readonly status?: number;

	constructor(kind: UsageFailureKind, message: string, status?: number) {
		super(message);
		this.name = "UsageError";
		this.kind = kind;
		if (status !== undefined) this.status = status;
	}
}

const MICRO_CENTS_PER_DOLLAR = 100_000_000;

const WINDOWS = [
	{ key: "fiveHour", kind: "five_hour", label: "Rolling 5h", short: "5h" },
	{ key: "week", kind: "calendar_week", label: "Weekly", short: "wk" },
	{
		key: "month",
		kind: "product_period",
		label: "Monthly",
		short: "mo",
		fallbackPeriodEnd: true,
		fallbackPeriodStart: true,
	},
] as const;

const asRecord = (value: unknown): Record<string, unknown> | null =>
	typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

const toNumber = (value: unknown): number | null => {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
};

/** Parse `access.meters` out of a `/api/go/status` payload. */
export function parseGoStatus(payload: unknown): UsageMeter[] {
	const access = asRecord(asRecord(payload)?.access);
	const meters = asRecord(access?.meters);
	if (!meters) return [];
	const periodEndMs = typeof access?.endsAt === "string" ? Date.parse(access.endsAt) : Number.NaN;
	const periodStartMs = typeof access?.startsAt === "string" ? Date.parse(access.startsAt) : Number.NaN;
	const result: UsageMeter[] = [];
	for (const window of WINDOWS) {
		const entry = asRecord(meters[window.key]);
		if (!entry) continue;
		const used = toNumber(entry.usedMicroCents);
		const limit = toNumber(entry.limitMicroCents);
		if (used === null || limit === null) continue;
		const usedUsd = used / MICRO_CENTS_PER_DOLLAR;
		const limitUsd = limit / MICRO_CENTS_PER_DOLLAR;
		const percent = limitUsd > 0 ? (usedUsd / limitUsd) * 100 : 0;
		const ownReset = typeof entry.resetsAt === "string" ? Date.parse(entry.resetsAt) : Number.NaN;
		const resetsAtMs = Number.isFinite(ownReset)
			? ownReset
			: "fallbackPeriodEnd" in window && window.fallbackPeriodEnd
				? periodEndMs
				: Number.NaN;
		const ownStart = typeof entry.startsAt === "string" ? Date.parse(entry.startsAt) : Number.NaN;
		const startsAtMs = Number.isFinite(ownStart)
			? ownStart
			: "fallbackPeriodStart" in window && window.fallbackPeriodStart
				? periodStartMs
				: Number.NaN;
		result.push({
			kind: window.kind,
			label: window.label,
			short: window.short,
			percent: Math.round(Math.min(100, Math.max(0, percent)) * 10) / 10,
			usedUsd,
			limitUsd,
			startsAt: Number.isFinite(startsAtMs) ? new Date(startsAtMs).toISOString() : null,
			resetsAt: Number.isFinite(resetsAtMs) ? new Date(resetsAtMs).toISOString() : null,
		});
	}
	return result;
}

/** Fetch the three Go meters for a workspace. */
export async function fetchGoUsage(
	server: string,
	token: string | undefined,
	orgId: string | undefined,
	signal?: AbortSignal
): Promise<UsageMeter[]> {
	if (!token) {
		throw new UsageError("no_credentials", "Not signed in to OpenCode Go.");
	}
	const headers: Record<string, string> = {
		Accept: "application/json",
		Authorization: `Bearer ${token}`,
	};
	if (orgId) {
		headers["x-org-id"] = orgId;
		headers["x-opencode-org-id"] = orgId;
	}
	let response: Response;
	try {
		response = await fetch(`${server}/api/go/status`, { headers, signal });
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			throw new UsageError("timeout", "OpenCode Go usage request timed out.");
		}
		throw new UsageError(
			"network",
			`OpenCode Go usage request failed: ${error instanceof Error ? error.message : String(error)}`
		);
	}
	if (response.status === 401 || response.status === 403) {
		throw new UsageError("unauthorized", "OpenCode Go session expired; sign in again.");
	}
	if (!response.ok) {
		throw new UsageError(
			"http",
			`OpenCode Go usage request failed (${response.status}).`,
			response.status
		);
	}
	const payload = (await response.json().catch(() => undefined)) as unknown;
	const meters = parseGoStatus(payload);
	if (meters.length === 0) {
		if (!asRecord(asRecord(payload)?.access)) {
			throw new UsageError("no_subscription", "No OpenCode Go subscription on this workspace.");
		}
		throw new UsageError("unrecognized", "OpenCode Go usage response was not recognised.");
	}
	return meters;
}

export function formatUsd(value: number): string {
	if (!Number.isFinite(value)) return "$0.00";
	const decimals = Math.abs(value) > 0 && Math.abs(value) < 1 ? 3 : 2;
	return `$${value.toFixed(decimals)}`;
}

export function formatPercent(percent: number): string {
	if (!Number.isFinite(percent)) return "0%";
	const rounded = Number.isInteger(percent) ? percent : Math.round(percent * 10) / 10;
	return `${rounded}%`;
}

export function formatBar(ratio: number, width = 18): string {
	const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
	const filled = Math.round(clamped * width);
	return `${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}`;
}

/**
 * Compare a meter's spend to a straight line across its own window.
 *
 * `deltaPoints` is used% minus the linear budget: positive means burning ahead
 * of the clock, negative means headroom. Returns null when the window bounds are
 * missing, malformed, or not currently active.
 */
export function computePace(meter: UsageMeter, now = Date.now()): MeterPace | null {
	if (!meter.startsAt || !meter.resetsAt) return null;
	const start = Date.parse(meter.startsAt);
	const end = Date.parse(meter.resetsAt);
	if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
	if (now <= start || now >= end) return null;
	const elapsedRatio = (now - start) / (end - start);
	const elapsedPercent = elapsedRatio * 100;
	const deltaPoints = meter.percent - elapsedPercent;
	const projectedPercent = elapsedRatio > 0 ? meter.percent / elapsedRatio : meter.percent;
	const remainingUsd = Math.max(0, meter.limitUsd - meter.usedUsd);
	const remainingHours = (end - now) / 3_600_000;
	return {
		elapsedPercent,
		deltaPoints,
		projectedPercent,
		remainingUsd,
		remainingHours,
		status:
			deltaPoints > PACE_BAND_POINTS
				? "over"
				: deltaPoints < -PACE_BAND_POINTS
					? "under"
					: "on",
	};
}

/** `under pace (-10.6 pts) · tracks to 62% · $2.23/day left`. */
export function formatPace(pace: MeterPace): string {
	const parts: string[] = [];
	if (pace.status === "on") {
		parts.push("on pace");
	} else {
		const sign = pace.deltaPoints > 0 ? "+" : "-";
		parts.push(`${pace.status} pace (${sign}${Math.abs(pace.deltaPoints).toFixed(1)} pts)`);
	}
	parts.push(`tracks to ${formatPercent(pace.projectedPercent)}`);
	// Hourly for the short windows, daily for the month; `$/day` is noise on 5h.
	const rate =
		pace.remainingHours <= 48
			? `${formatUsd(pace.remainingUsd / pace.remainingHours)}/hr left`
			: `${formatUsd(pace.remainingUsd / (pace.remainingHours / 24))}/day left`;
	parts.push(rate);
	return parts.join(" · ");
}

export function formatCountdown(resetsAt: string | null, now = Date.now()): string | null {
	if (!resetsAt) return null;
	const target = Date.parse(resetsAt);
	if (!Number.isFinite(target)) return null;
	const ms = target - now;
	if (ms <= 0) return "resets now";
	const totalMinutes = Math.floor(ms / 60_000);
	const days = Math.floor(totalMinutes / (60 * 24));
	const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m`;
}

/** One aligned meter row: `Rolling 5h  ██████░░░░  62%  $12.00 / $19.20  1h 12m`. */
export function formatMeterRow(meter: UsageMeter, barWidth = 18, now = Date.now()): string {
	const ratio = meter.limitUsd > 0 ? meter.usedUsd / meter.limitUsd : 0;
	const bar = formatBar(ratio, barWidth);
	const pct = formatPercent(meter.percent).padStart(5);
	const money = `${formatUsd(meter.usedUsd)} / ${formatUsd(meter.limitUsd)}`;
	const countdown = formatCountdown(meter.resetsAt, now);
	return `${meter.label.padEnd(11)} ${bar}  ${pct}  ${money.padEnd(19)}${
		countdown ? `  ${countdown}` : ""
	}`;
}

export function describeUsageError(error: unknown): string {
	if (error instanceof UsageError) {
		switch (error.kind) {
			case "no_credentials":
				return "Not signed in. Run /login opencode-go.";
			case "unauthorized":
				return "Session expired. Run /login opencode-go again.";
			case "no_subscription":
				return "No OpenCode Go subscription on this workspace.";
			case "unrecognized":
				return "OpenCode Go usage response was not recognised.";
			default:
				return error.message;
		}
	}
	return error instanceof Error ? error.message : String(error);
}
