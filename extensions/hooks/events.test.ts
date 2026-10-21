import { describe, expect, it } from "vitest";
import {
	canonicalEvent,
	globToRegExp,
	matcherSubject,
	matchesMatcher,
	matchesPermissionRule,
	parsePermissionRule,
	ruleSubject,
} from "./events.ts";

describe("canonicalEvent", () => {
	it("accepts Claude names and pi aliases", () => {
		expect(canonicalEvent("PreToolUse")).toBe("PreToolUse");
		expect(canonicalEvent("pre_tool_use")).toBe("PreToolUse");
		expect(canonicalEvent("tool_call")).toBe("PreToolUse");
		expect(canonicalEvent("tool_result")).toBe("PostToolUse");
		expect(canonicalEvent("session_shutdown")).toBe("SessionEnd");
		expect(canonicalEvent("agent_before_settle")).toBe("Stop");
	});

	it("rejects unknown names", () => {
		expect(canonicalEvent("NotAThing")).toBeUndefined();
	});
});

describe("matchesMatcher", () => {
	it("matches everything when omitted, empty, or star", () => {
		expect(matchesMatcher(undefined, "bash")).toBe(true);
		expect(matchesMatcher("", "bash")).toBe(true);
		expect(matchesMatcher("*", "bash")).toBe(true);
	});

	it("treats simple strings as an exact list", () => {
		expect(matchesMatcher("bash|write|edit", "write")).toBe(true);
		expect(matchesMatcher("bash,write", "edit")).toBe(false);
		expect(matchesMatcher("Write", "write")).toBe(false);
		expect(matchesMatcher("Write", "write", true)).toBe(true);
	});

	it("treats anything else as a regular expression", () => {
		expect(matchesMatcher("^mcp__.*", "mcp__jira__create")).toBe(true);
		expect(matchesMatcher("^mcp__.*", "bash")).toBe(false);
	});

	it("ignores an invalid regular expression", () => {
		expect(matchesMatcher("([", "bash")).toBe(false);
	});
});

describe("permission rules", () => {
	it("parses tool and pattern", () => {
		expect(parsePermissionRule("Bash(git *)")).toEqual({
			tool: "Bash",
			pattern: "git *",
		});
		expect(parsePermissionRule("Edit")).toEqual({ tool: "Edit" });
		expect(parsePermissionRule("Bash()")).toEqual({ tool: "Bash" });
		expect(parsePermissionRule("Bash(git *")).toBeUndefined();
	});

	it("matches bash commands with globs, accepting Claude casing", () => {
		const rule = parsePermissionRule("Bash(git *)")!;
		expect(matchesPermissionRule(rule, "bash", { command: "git status" })).toBe(true);
		expect(matchesPermissionRule(rule, "bash", { command: "rm -rf /" })).toBe(false);
	});

	it("matches paths anywhere in the glob", () => {
		const rule = parsePermissionRule("Edit(*.ts)")!;
		expect(matchesPermissionRule(rule, "edit", { path: "src/index.ts" })).toBe(true);
		expect(matchesPermissionRule(rule, "edit", { path: "src/index.js" })).toBe(false);
	});

	it("supports MCP wildcards", () => {
		const rule = parsePermissionRule("mcp__jira__*")!;
		expect(matchesPermissionRule(rule, "mcp__jira__create", {})).toBe(true);
		expect(matchesPermissionRule(rule, "mcp__docs__read", {})).toBe(false);
	});
});

describe("ruleSubject", () => {
	it("uses the command for bash and the path for file tools", () => {
		expect(ruleSubject("bash", { command: "ls" })).toBe("ls");
		expect(ruleSubject("read", { file_path: "/tmp/a" })).toBe("/tmp/a");
		expect(ruleSubject("grep", { pattern: "TODO" })).toBe("TODO");
	});
});

describe("matcherSubject", () => {
	it("uses the tool name for tool events", () => {
		expect(matcherSubject("PreToolUse", { tool_name: "bash" })).toBe("bash");
		expect(matcherSubject("SessionStart", { source: "resume" })).toBe("resume");
		expect(matcherSubject("FileChanged", { file_path: "a.ts" })).toBe("a.ts");
	});
});

describe("globToRegExp", () => {
	it("anchors and escapes", () => {
		expect(globToRegExp("a.b*").test("a.bcd")).toBe(true);
		expect(globToRegExp("a.b*").test("axbcd")).toBe(false);
		expect(globToRegExp("rm ?").test("rm x")).toBe(true);
	});
});
