import { describe, expect, it } from "vitest";
import { buildOpenCodeGoProvider, formatStatusMeters } from "./index.ts";
import type { UsageMeter } from "./usage.ts";

const meter = (over: Partial<UsageMeter> & Pick<UsageMeter, "kind" | "short">): UsageMeter => ({
	label: over.short,
	percent: 0,
	usedUsd: 0,
	limitUsd: 0,
	startsAt: null,
	resetsAt: null,
	...over,
});

describe("buildOpenCodeGoProvider", () => {
	it("registers OpenCode Go with built-in models and a provisioning login", () => {
		const provider = buildOpenCodeGoProvider();
		expect(provider.id).toBe("opencode-go");
		expect(provider.name).toBe("OpenCode Go");
		expect(provider.auth.apiKey).toBeDefined();
		expect(typeof provider.auth.apiKey?.login).toBe("function");
		expect(provider.auth.oauth).toBeUndefined();
		expect(provider.getModels().length).toBeGreaterThan(0);
	});
});

describe("formatStatusMeters", () => {
	const now = Date.parse("2026-10-09T10:00:00.000Z");

	it("adds reset countdowns for the 5h and monthly windows", () => {
		const status = formatStatusMeters(
			[
				meter({ kind: "five_hour", short: "5h", percent: 62, resetsAt: "2026-10-09T11:12:00.000Z" }),
				meter({ kind: "calendar_week", short: "wk", percent: 31 }),
				meter({
					kind: "product_period",
					short: "mo",
					percent: 44,
					resetsAt: "2026-10-21T10:00:00.000Z",
				}),
			],
			now
		);
		expect(status).toBe("go 5h 62% (1h 12m) · wk 31% · mo 44% (12d 0h)");
	});

	it("omits countdowns when a reset is unknown", () => {
		expect(
			formatStatusMeters(
				[
					meter({ kind: "five_hour", short: "5h", percent: 10 }),
					meter({ kind: "product_period", short: "mo", percent: 5 }),
				],
				now
			)
		).toBe("go 5h 10% · mo 5%");
	});

	it("returns undefined with no meters", () => {
		expect(formatStatusMeters([], now)).toBeUndefined();
	});
});
