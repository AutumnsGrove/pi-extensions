/**
 * OpenCode Go usage meters.
 *
 * The Console HTML is client-rendered, so the numbers come from the JSON API:
 *
 *   GET /api/go/status   (Authorization: Bearer <session-or-key>, x-org-id)
 *   -> { access: { meters: {
 *          fiveHour: { resetsAt, limitMicroCents, usedMicroCents },
 *          week:     { resetsAt, limitMicroCents, usedMicroCents },
 *          month:    { limitMicroCents, usedMicroCents } } } }
 *
 * Money is micro-cents (1e-8 USD). Percentages are used / limit; the month
 * meter has no window of its own, so its reset falls back to `access.endsAt`.
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
	/** ISO timestamp of rollover, or null when unknown. */
	resetsAt: string | null;
}

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
	{ key: "month", kind: "product_period", label: "Monthly", short: "mo", fallbackPeriodEnd: true },
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
		result.push({
			kind: window.kind,
			label: window.label,
			short: window.short,
			percent: Math.round(Math.min(100, Math.max(0, percent)) * 10) / 10,
			usedUsd,
			limitUsd,
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
