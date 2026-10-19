import { describe, expect, it } from "vitest";
import {
	elapsedLabel,
	formatBackgroundNotice,
	formatDuration,
	formatJobDetails,
	formatJobLine,
	formatJobsList,
	formatNotification,
	formatRunningReminder,
	formatWidgetLine,
	isRecentlyFinished,
	previewCommand,
	resolveWidgetTtlMs,
	statusGlyph,
	statusLabel,
	stripAnsi,
} from "./format.ts";
import type { JobSummary } from "./jobs.ts";

const base: JobSummary = {
	id: "b7f3k9a2x1",
	command: "pnpm build",
	cwd: "/repo",
	logPath: "/tmp/pi-bg/b7f3k9a2x1.log",
	status: "completed",
	startedAt: 1_000_000,
	endedAt: 1_134_000,
	exitCode: 0,
	detached: true,
	read: false,
	notified: false,
	notifyOnExit: true,
};

const job = (overrides: Partial<JobSummary> = {}): JobSummary => ({ ...base, ...overrides });

describe("stripAnsi", () => {
	it("removes CSI color codes and control bytes", () => {
		expect(stripAnsi("\u001b[31mred\u001b[0m text\u0007")).toBe("red text");
	});

	it("removes OSC hyperlinks", () => {
		expect(stripAnsi("\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007")).toBe("link");
	});
});

describe("formatDuration", () => {
	it("formats milliseconds, seconds, minutes, and hours", () => {
		expect(formatDuration(400)).toBe("400ms");
		expect(formatDuration(1_500)).toBe("1.5s");
		expect(formatDuration(12_000)).toBe("12s");
		expect(formatDuration(134_000)).toBe("2m14s");
		expect(formatDuration(3_600_000)).toBe("1h00m");
	});

	it("never goes negative", () => {
		expect(formatDuration(-50)).toBe("0ms");
	});
});

describe("previewCommand", () => {
	it("collapses whitespace and truncates", () => {
		expect(previewCommand("  npm   run \n build  ")).toBe("npm run build");
		expect(previewCommand("x".repeat(20), 10)).toBe(`${"x".repeat(9)}…`);
	});
});

describe("status labels", () => {
	it("uses glyphs per status", () => {
		expect(statusGlyph("running")).toBe("●");
		expect(statusGlyph("completed")).toBe("✓");
		expect(statusGlyph("failed")).toBe("✗");
		expect(statusGlyph("killed")).toBe("■");
	});

	it("includes exit codes and signals", () => {
		expect(statusLabel(job({ status: "running", endedAt: undefined }))).toBe("running");
		expect(statusLabel(job({ status: "failed", exitCode: 2 }))).toBe("failed (exit 2)");
		expect(statusLabel(job({ status: "failed", signal: "SIGKILL", exitCode: null }))).toBe(
			"failed (SIGKILL)"
		);
		expect(statusLabel(job({ status: "killed", reason: "killed" }))).toBe("killed");
		expect(statusLabel(job({ status: "killed", reason: "timeout" }))).toBe("killed (timeout)");
		expect(statusLabel(job({ status: "completed" }))).toBe("completed");
	});
});

describe("isRecentlyFinished", () => {
	const now = 1_000_000;

	it("keeps a finished job in the widget for 30 seconds", () => {
		expect(isRecentlyFinished(job({ endedAt: now - 10_000 }), now)).toBe(true);
		expect(isRecentlyFinished(job({ endedAt: now - 30_001 }), now)).toBe(false);
	});

	it("hides read, running, and killed jobs", () => {
		expect(isRecentlyFinished(job({ endedAt: now - 1_000, read: true }), now)).toBe(false);
		expect(isRecentlyFinished(job({ status: "running", endedAt: undefined }), now)).toBe(false);
		expect(isRecentlyFinished(job({ status: "killed", reason: "killed" }), now)).toBe(false);
	});
});

describe("resolveWidgetTtlMs", () => {
	it("reads PI_BG_WIDGET_TTL and falls back on bad values", () => {
		const previous = process.env.PI_BG_WIDGET_TTL;
		try {
			process.env.PI_BG_WIDGET_TTL = "5";
			expect(resolveWidgetTtlMs()).toBe(5000);
			process.env.PI_BG_WIDGET_TTL = "nope";
			expect(resolveWidgetTtlMs()).toBe(30_000);
		} finally {
			if (previous === undefined) delete process.env.PI_BG_WIDGET_TTL;
			else process.env.PI_BG_WIDGET_TTL = previous;
		}
	});
});

describe("job lines", () => {
	it("includes id, status, elapsed, and command", () => {
		const line = formatJobLine(job(), { now: 1_134_000 });
		expect(line).toContain("b7f3k9a2x1");
		expect(line).toContain("completed");
		expect(line).toContain("2m14s");
		expect(line).toContain("pnpm build");
	});

	it("marks finished unread jobs", () => {
		expect(formatJobLine(job(), { unread: true, now: 1_134_000 })).toContain("(unread)");
		expect(formatJobLine(job({ read: true }), { unread: true, now: 1_134_000 })).not.toContain(
			"(unread)"
		);
	});

	it("summarises a list", () => {
		const running = job({ id: "b1", status: "running", endedAt: undefined, command: "pnpm dev" });
		const text = formatJobsList([running, job({ id: "b2" })], 1_134_000);
		expect(text.split("\n")[0]).toBe("1 running, 1 finished");
		expect(text).toContain("b1");
		expect(text).toContain("b2");
	});

	it("renders one compact widget line", () => {
		const line = formatWidgetLine(job(), 1_134_000);
		expect(line).toContain("✓");
		expect(line).toContain("b7f3k9a2x1");
		expect(line).toContain("2m14s");
	});
});

describe("notifications", () => {
	it("tells the agent how to inspect a backgrounded command", () => {
		const text = formatBackgroundNotice(job({ status: "running", endedAt: undefined }));
		expect(text).toContain("Command running in the background with ID: b7f3k9a2x1");
		expect(text).toContain("/tmp/pi-bg/b7f3k9a2x1.log");
		expect(text).toContain('jobs({ action: "output"');
	});

	it("wraps completion in a task-notification with a tail", () => {
		const text = formatNotification(job({ status: "failed", exitCode: 2 }), "line one\nline two\n");
		expect(text).toContain("<task-notification>");
		expect(text).toContain("<task-id>b7f3k9a2x1</task-id>");
		expect(text).toContain("<status>failed</status>");
		expect(text).toContain("<exit-code>2</exit-code>");
		expect(text).toContain("line one\nline two");
		expect(text).toContain("jobs({ action: \"output\"");
	});

	it("keeps only the requested tail lines", () => {
		const text = formatNotification(job(), "1\n2\n3\n4\n5\n", { maxOutputLines: 2 });
		expect(text).toContain("<output>\n4\n5\n</output>");
	});

	it("reminds the agent about running jobs after compaction", () => {
		expect(formatRunningReminder([job()])).toBeUndefined();
		const reminder = formatRunningReminder([
			job({ status: "running", endedAt: undefined, command: "pnpm dev" }),
		]);
		expect(reminder).toContain("1 background job is still running");
		expect(reminder).toContain("pnpm dev");
	});

	it("formats a job detail block for /bg", () => {
		const text = formatJobDetails(job(), "build output");
		expect(text).toContain("✓ b7f3k9a2x1 — completed");
		expect(text).toContain("Command: pnpm build");
		expect(text).toContain("build output");
	});

	it("uses the end time for elapsed", () => {
		expect(elapsedLabel(job(), 9_999_999)).toBe("2m14s");
	});
});
