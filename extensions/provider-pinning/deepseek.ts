/**
 * DeepSeek's official API bills peak and off-peak rates: off-peak is half of
 * peak. The windows are fixed to UTC, so they land at awkward local hours
 * everywhere outside China, and a Chinese public holiday is off-peak in full.
 *
 * This module is the single source of truth for that schedule so the status
 * line can say, at a glance, whether pinning to DeepSeek is currently cheap.
 *
 * Source: https://api-docs.deepseek.com/quick_start/pricing/
 * "Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday,
 * excluding Chinese public holidays. All other hours are off-peak, including
 * weekends and Chinese public holidays in full."
 */

export type DeepseekPeriod = "peak" | "off-peak";

/** Peak windows as [startHour, endHour) in UTC. */
const PEAK_WINDOWS_UTC: ReadonlyArray<readonly [number, number]> = [
	[1, 4],
	[6, 10],
];

/** Every UTC hour a window can start or end at. Used to find transitions. */
const PEAK_BOUNDARIES_UTC: readonly number[] = [1, 4, 6, 10];

/**
 * Chinese public holidays as Beijing civil dates (YYYY-MM-DD). DeepSeek bills a
 * whole holiday block off-peak, so the weekends folded into one are listed too.
 * Source: State Council notice 国办发明电〔2025〕7号 for 2026.
 *
 * The 2027 notice was still unpublished as of October 2026; add it here when it
 * lands (usually late Oct–early Dec) or the schedule will over-charge holidays.
 */
export const CHINESE_PUBLIC_HOLIDAYS: ReadonlySet<string> = new Set([
	// New Year
	"2026-01-01",
	"2026-01-02",
	"2026-01-03",
	// Spring Festival
	"2026-02-15",
	"2026-02-16",
	"2026-02-17",
	"2026-02-18",
	"2026-02-19",
	"2026-02-20",
	"2026-02-21",
	"2026-02-22",
	"2026-02-23",
	// Qingming
	"2026-04-04",
	"2026-04-05",
	"2026-04-06",
	// Labour Day
	"2026-05-01",
	"2026-05-02",
	"2026-05-03",
	"2026-05-04",
	"2026-05-05",
	// Dragon Boat
	"2026-06-19",
	"2026-06-20",
	"2026-06-21",
	// Mid-Autumn
	"2026-09-25",
	"2026-09-26",
	"2026-09-27",
	// National Day
	"2026-10-01",
	"2026-10-02",
	"2026-10-03",
	"2026-10-04",
	"2026-10-05",
	"2026-10-06",
	"2026-10-07",
]);

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** Beijing has no DST, so a fixed +08:00 offset is exact year-round. */
export const beijingDate = (date: Date): string => {
	const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
	return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(
		shifted.getUTCDate()
	)}`;
};

export const isChinesePublicHoliday = (date: Date): boolean =>
	CHINESE_PUBLIC_HOLIDAYS.has(beijingDate(date));

/**
 * DeepSeek's current billing period. Weekends and Chinese public holidays are
 * off-peak regardless of the clock; otherwise the two UTC windows are peak.
 */
export const deepseekPeriod = (date: Date): DeepseekPeriod => {
	const day = date.getUTCDay();
	if (day === 0 || day === 6 || isChinesePublicHoliday(date)) {
		return "off-peak";
	}
	const hour = date.getUTCHours() + date.getUTCMinutes() / 60;
	for (const [start, end] of PEAK_WINDOWS_UTC) {
		if (hour >= start && hour < end) {
			return "peak";
		}
	}
	return "off-peak";
};

/**
 * The next instant the period flips. Only four instants a day can flip it, so
 * scan a week of candidates rather than polling every minute. Returns null when
 * nothing is found in the horizon, which cannot happen in practice.
 */
export const nextDeepseekTransition = (from: Date): Date | null => {
	const current = deepseekPeriod(from);
	const horizon = from.getTime() + 9 * 24 * 60 * 60 * 1000;
	const dayStart = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
	for (let day = 0; day < 10; day += 1) {
		for (const hour of PEAK_BOUNDARIES_UTC) {
			const candidate = new Date(dayStart + day * 86_400_000 + hour * 3_600_000);
			if (candidate.getTime() <= from.getTime() || candidate.getTime() > horizon) {
				continue;
			}
			if (deepseekPeriod(candidate) !== current) {
				return candidate;
			}
		}
	}
	return null;
};

/** "45m", "2h5m", or "2d3h" from a millisecond span. */
export const formatRemaining = (ms: number): string => {
	const total = Math.max(0, Math.floor(ms / 60_000));
	const days = Math.floor(total / 1440);
	const hours = Math.floor((total % 1440) / 60);
	const minutes = total % 60;
	if (days > 0) {
		return `${days}d${hours}h`;
	}
	if (hours > 0) {
		return `${hours}h${minutes}m`;
	}
	return `${minutes}m`;
};

/** Is this provider name or tag DeepSeek's own first-party API endpoint? */
export const isDeepseekProvider = (value: string | undefined): boolean => {
	if (!value) {
		return false;
	}
	const normalized = value.trim().toLowerCase();
	return normalized === "deepseek" || normalized.startsWith("deepseek/");
};

/**
 * Compact status-line badge, e.g. "DS off-peak 2d3h" or "DS peak 1h58m". The
 * trailing span is how long the current period still runs.
 */
export const deepseekBadge = (now: Date = new Date()): string => {
	const period = deepseekPeriod(now);
	const next = nextDeepseekTransition(now);
	const label = period === "peak" ? "peak" : "off-peak";
	return next
		? `DS ${label} ${formatRemaining(next.getTime() - now.getTime())}`
		: `DS ${label}`;
};
