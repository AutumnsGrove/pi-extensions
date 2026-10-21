import { describe, expect, it } from "vitest";
import {
	appleScript,
	buildAborted,
	buildAttention,
	buildError,
	buildFinished,
	buildQuestion,
	buildTest,
	encodeTerminal,
	formatDuration,
	notificationTitle,
	planDelivery,
	plainText,
	promptLabel,
	sanitize,
	sessionLabel,
	shouldNotify,
	snippet,
	terminalBundleId,
	terminalNotifierArgs,
	terminalProtocol,
	truncate,
	type Notification,
} from "./notify.ts";

const notification = (title: string, body: string): Notification => ({
	kind: "finished",
	title,
	body,
});

describe("formatDuration", () => {
	it("renders seconds, minutes and hours", () => {
		expect(formatDuration(0)).toBe("0s");
		expect(formatDuration(12_400)).toBe("12s");
		expect(formatDuration(84_000)).toBe("1m 24s");
		expect(formatDuration(120_000)).toBe("2m");
		expect(formatDuration(3_600_000)).toBe("1h");
		expect(formatDuration(3_661_000)).toBe("1h 1m");
	});
});

describe("sanitize", () => {
	it("strips control bytes and collapses whitespace", () => {
		expect(sanitize("a\x07b\x1bc\nd\t e")).toBe("a b c d e");
		expect(sanitize("  keep   me  ")).toBe("keep me");
	});
});

describe("truncate", () => {
	it("keeps short strings and clips at a word boundary", () => {
		expect(truncate("short", 10)).toBe("short");
		expect(truncate("one two three four", 12)).toBe("one two…");
		expect(truncate("supercalifragilistic", 10)).toBe("supercali…");
	});
});

describe("plainText", () => {
	it("flattens markdown into one line", () => {
		const markdown = [
			"## Summary",
			"",
			"Refactored the `token` **refresh** path.",
			"",
			"```ts",
			"const secret = 1;",
			"```",
			"See [the docs](https://example.com).",
		].join("\n");
		expect(plainText(markdown)).toBe(
			"Summary Refactored the token refresh path. See the docs."
		);
	});

	it("keeps underscores in identifiers", () => {
		expect(plainText("pass max_lines and min_score")).toBe(
			"pass max_lines and min_score"
		);
	});
});

describe("sessionLabel", () => {
	it("prefers the session name and falls back to the folder", () => {
		expect(sessionLabel("auth-refactor", "/repo/pi")).toBe("auth-refactor");
		expect(sessionLabel(undefined, "/repo/pi-extensions")).toBe("pi-extensions");
		expect(sessionLabel("  ", "/repo/pi-extensions")).toBe("pi-extensions");
		expect(sessionLabel(undefined, "/")).toBe("pi");
	});
});

describe("titles", () => {
	it("combines the kind with the session", () => {
		expect(notificationTitle("finished", "auth-refactor")).toBe(
			"Pi · auth-refactor"
		);
		expect(notificationTitle("attention", "auth-refactor")).toBe(
			"Pi needs you · auth-refactor"
		);
		expect(notificationTitle("question", "auth-refactor")).toBe(
			"Pi has a question · auth-refactor"
		);
	});
});

describe("builders", () => {
	it("summarizes a finished run with its duration", () => {
		const result = buildFinished({
			session: "auth-refactor",
			durationMs: 84_000,
			text: "Refactored the token refresh path and added tests.",
		});
		expect(result.title).toBe("Pi · auth-refactor");
		expect(result.body).toBe(
			"Finished in 1m 24s — Refactored the token refresh path and added tests."
		);
	});

	it("omits the summary when the run produced no text", () => {
		expect(buildFinished({ session: "pi", durationMs: 5_000 }).body).toBe(
			"Finished in 5s"
		);
	});

	it("prefers the provider error message", () => {
		const result = buildError({
			session: "pi",
			durationMs: 1_000,
			errorMessage: "rate limited",
			text: "irrelevant",
		});
		expect(result.title).toBe("Pi hit an error · pi");
		expect(result.body).toBe("Error after 1s — rate limited");
	});

	it("reports a stopped run", () => {
		expect(buildAborted({ session: "pi", durationMs: 4_000 }).body).toBe(
			"Stopped after 4s"
		);
	});

	it("uses the dialog title when given, otherwise the kind label", () => {
		expect(
			buildAttention({
				session: "pi",
				promptKind: "confirm",
				detail: "Allow rm -rf?",
			}).body
		).toBe("Allow rm -rf?");
		expect(
			buildAttention({ session: "pi", promptKind: "confirm" }).body
		).toBe("A confirmation is waiting for you.");
	});

	it("carries the first question", () => {
		const result = buildQuestion({
			session: "pi",
			question: "Which database should we use?",
		});
		expect(result.title).toBe("Pi has a question · pi");
		expect(result.body).toBe("Which database should we use?");
	});

	it("falls back when a question has no text", () => {
		expect(buildQuestion({ session: "pi" }).body).toBe(
			"Waiting for your answer."
		);
	});

	it("builds a preview", () => {
		expect(buildTest("pi").body).toBe("Desktop notifications are working.");
	});
});

describe("promptLabel", () => {
	it("describes each prompt kind", () => {
		expect(promptLabel("select")).toBe("A choice is waiting for you.");
		expect(promptLabel("editor")).toBe("An editor is waiting for you.");
		expect(promptLabel("something-else")).toBe("Waiting for your input.");
	});
});

describe("shouldNotify", () => {
	it("requires three seconds for a successful run", () => {
		expect(shouldNotify("finished", 2_999)).toBe(false);
		expect(shouldNotify("finished", 3_000)).toBe(true);
		expect(shouldNotify("finished", undefined)).toBe(false);
	});

	it("always allows errors and questions", () => {
		expect(shouldNotify("error", 0)).toBe(true);
		expect(shouldNotify("attention", undefined)).toBe(true);
		expect(shouldNotify("question", 0)).toBe(true);
	});

	it("applies the threshold to a user-stopped run", () => {
		expect(shouldNotify("aborted", 1_000)).toBe(false);
		expect(shouldNotify("aborted", 3_500)).toBe(true);
	});
});

describe("terminalProtocol", () => {
	it("detects the OSC 9 terminals Claude Code uses", () => {
		expect(terminalProtocol({ TERM_PROGRAM: "ghostty" })).toBe("osc9");
		expect(terminalProtocol({ TERM_PROGRAM: "iTerm.app" })).toBe("osc9");
		expect(terminalProtocol({ TERM_PROGRAM: "WezTerm" })).toBe("osc9");
	});

	it("keeps rxvt's native OSC 777", () => {
		expect(terminalProtocol({ TERM: "rxvt-unicode-256color" })).toBe("osc777");
	});

	it("detects kitty's OSC 99", () => {
		expect(terminalProtocol({ TERM: "xterm-kitty" })).toBe("osc99");
		expect(terminalProtocol({ KITTY_WINDOW_ID: "1" })).toBe("osc99");
	});

	it("falls back for unknown terminals and non-TTY output", () => {
		expect(terminalProtocol({ TERM_PROGRAM: "Apple_Terminal" })).toBe("none");
		expect(terminalProtocol({}, false)).toBe("none");
		expect(terminalProtocol({ TERM_PROGRAM: "ghostty" }, false)).toBe("none");
	});
});

describe("terminalBundleId", () => {
	it("maps the known terminal programs", () => {
		expect(terminalBundleId({ TERM_PROGRAM: "ghostty" })).toBe(
			"com.mitchellh.ghostty"
		);
		expect(terminalBundleId({ TERM_PROGRAM: "iTerm.app" })).toBe(
			"com.googlecode.iterm2"
		);
		expect(terminalBundleId({ TERM_PROGRAM: "WezTerm" })).toBe(
			"com.github.wez.wezterm"
		);
		expect(terminalBundleId({ TERM_PROGRAM: "Apple_Terminal" })).toBeUndefined();
	});
});

describe("encodeTerminal", () => {
	it("writes an OSC 9 message with the session and body", () => {
		expect(encodeTerminal(notification("Pi · pi", "hi"), "osc9")).toBe(
			"\x1b]9;Pi · pi — hi\x07"
		);
	});

	it("writes an rxvt OSC 777 sequence", () => {
		expect(encodeTerminal(notification("Pi · pi", "hi"), "osc777")).toBe(
			"\x1b]777;notify;Pi · pi;hi\x07"
		);
	});

	it("writes a kitty OSC 99 title and body", () => {
		expect(encodeTerminal(notification("Pi · pi", "hi"), "osc99")).toBe(
			"\x1b]99;i=pi:d=0;Pi · pi\x1b\\\x1b]99;i=pi:p=body;hi\x1b\\"
		);
	});

	it("cannot be injected with control bytes", () => {
		const encoded = encodeTerminal(
			notification("Pi;evil\x07", "body\x1b]777;notify;x;y\x07"),
			"osc777"
		);
		expect(encoded).not.toContain("\x07\x07");
		expect(encoded.match(/\x07/g)).toHaveLength(1);
		expect(encoded).not.toContain("\x1b]777;notify;x;y");
	});
});

describe("appleScript", () => {
	it("escapes quotes and backslashes", () => {
		expect(appleScript(notification('Pi "quoted"', "back\\slash"))).toBe(
			'display notification "back\\\\slash" with title "Pi \\"quoted\\""'
		);
	});
});

describe("terminalNotifierArgs", () => {
	it("carries the sender for the Ghostty icon and click-to-focus", () => {
		expect(
			terminalNotifierArgs(notification("Pi", "hi"), "com.mitchellh.ghostty")
		).toEqual([
			"-title",
			"Pi",
			"-message",
			"hi",
			"-group",
			"pi-notify",
			"-sender",
			"com.mitchellh.ghostty",
			"-activate",
			"com.mitchellh.ghostty",
		]);
	});
});

describe("planDelivery", () => {
	it("prefers the terminal protocol", () => {
		const plan = planDelivery(notification("Pi", "hi"), {
			env: { TERM_PROGRAM: "ghostty" },
			isTTY: true,
		});
		expect(plan?.kind).toBe("stdout");
	});

	it("uses terminal-notifier when it is installed", () => {
		const plan = planDelivery(notification("Pi", "hi"), {
			env: { TERM_PROGRAM: "Apple_Terminal" },
			platform: "darwin",
			isTTY: true,
			macNotifier: "terminal-notifier",
			sender: "com.mitchellh.ghostty",
		});
		expect(plan?.command).toBe("terminal-notifier");
		expect(plan?.args).toContain("com.mitchellh.ghostty");
	});

	it("falls back to osascript on macOS", () => {
		const plan = planDelivery(notification("Pi", "hi"), {
			env: { TERM_PROGRAM: "Apple_Terminal" },
			platform: "darwin",
			isTTY: true,
		});
		expect(plan).toEqual({
			kind: "exec",
			command: "osascript",
			args: ["-e", 'display notification "hi" with title "Pi"'],
		});
	});

	it("falls back to notify-send on Linux", () => {
		const plan = planDelivery(notification("Pi", "hi"), {
			env: {},
			platform: "linux",
			isTTY: false,
		});
		expect(plan).toEqual({
			kind: "exec",
			command: "notify-send",
			args: ["Pi", "hi"],
		});
	});

	it("has no transport on other platforms", () => {
		expect(
			planDelivery(notification("Pi", "hi"), {
				env: {},
				platform: "win32",
				isTTY: false,
			})
		).toBeUndefined();
	});
});

describe("snippet", () => {
	it("truncates a long answer", () => {
		const long = `${"word ".repeat(60)}end`;
		const result = snippet(long);
		expect(result.length).toBeLessThanOrEqual(160);
		expect(result.endsWith("…")).toBe(true);
	});
});
