import { describe, expect, it } from "vitest";
import {
	DEFAULT_ALLOW,
	DEFAULT_DENY,
	callKey,
	defaultRules,
	evaluateRules,
	ruleForCall,
} from "./rules.ts";
import type { RuleEntry } from "./types.ts";

const rules = defaultRules();

function evalBash(command: string, extra: Partial<typeof rules> = {}) {
	return evaluateRules("bash", { command }, { ...rules, ...extra });
}

describe("default rules", () => {
	it("denies catastrophic commands", () => {
		expect(evalBash("rm -rf /").decision).toBe("deny");
		expect(evalBash("sudo rm -rf /tmp/x").decision).toBe("deny");
		expect(evalBash("mkfs.ext4 /dev/sda").decision).toBe("deny");
	});

	it("allows read-only commands", () => {
		expect(evalBash("git status").decision).toBe("allow");
		expect(evalBash("cat package.json").decision).toBe("allow");
		expect(evalBash("rg TODO src").decision).toBe("allow");
		expect(evaluateRules("read", { path: "a.ts" }, rules).decision).toBe("allow");
	});

	it("asks for common risky commands", () => {
		expect(evalBash("npm publish").decision).toBe("ask");
		expect(evalBash("git push origin main").decision).toBe("ask");
		expect(evalBash("curl https://example.test").decision).toBe("ask");
	});
});

describe("compound commands", () => {
	it("requires every segment to be allowed", () => {
		expect(evalBash("git status && rm -rf /").decision).toBe("deny");
		expect(evalBash("git status && npm install").decision).toBe("none");
		expect(evalBash("git status && git diff").decision).toBe("allow");
	});

	it("cannot smuggle a write past a read-only allow rule", () => {
		const verdict = evalBash("cat package.json > /tmp/leak");
		expect(verdict.decision).not.toBe("allow");
	});

	it("asks on opaque shell constructs", () => {
		const verdict = evalBash("echo $(rm -rf /tmp/x)");
		expect(verdict.decision).toBe("ask");
		expect(verdict.reasons[0]).toContain("opaque");
	});

	it("still lets a deny rule match an opaque command", () => {
		expect(evalBash("bash -c 'rm -rf /'").decision).toBe("deny");
	});
});

describe("precedence", () => {
	it("deny beats allow", () => {
		const custom: RuleEntry[] = [
			{ rule: "Bash(git status)", source: "global" },
			{ rule: "Bash(git *)", source: "global" },
		];
		const verdict = evaluateRules(
			"bash",
			{ command: "git status" },
			{
				allow: custom,
				ask: [],
				deny: [{ rule: "Bash(git *)", source: "global" }],
			},
		);
		expect(verdict.decision).toBe("deny");
	});

	it("ask beats allow", () => {
		const verdict = evaluateRules(
			"bash",
			{ command: "git status" },
			{
				allow: [{ rule: "Bash(git *)", source: "global" }],
				ask: [{ rule: "Bash(git status)", source: "global" }],
				deny: [],
			},
		);
		expect(verdict.decision).toBe("ask");
	});
});

describe("ruleForCall", () => {
	it("builds a Claude-style rule", () => {
		expect(ruleForCall("bash", { command: "npm install" })).toBe("Bash(npm install)");
		expect(ruleForCall("edit", { path: "src/a.ts" })).toBe("Edit(src/a.ts)");
		expect(ruleForCall("write", { path: "src/a.ts" })).toBe("Write(src/a.ts)");
		expect(ruleForCall("mcp__jira__create", {})).toBe("mcp__jira__create");
	});

	it("refuses a rule it cannot express", () => {
		expect(ruleForCall("bash", { command: "echo (x)" })).toBeUndefined();
	});
});

describe("callKey", () => {
	it("normalizes bash whitespace and includes cwd", () => {
		const a = callKey("bash", { command: "  git   status " }, "/repo");
		const b = callKey("bash", { command: "git status" }, "/repo");
		const c = callKey("bash", { command: "git status" }, "/other");
		expect(a).toBe(b);
		expect(a).not.toBe(c);
	});
});

describe("default lists", () => {
	it("do not contain the same rule in allow and deny", () => {
		const overlap = DEFAULT_ALLOW.filter((rule) => DEFAULT_DENY.includes(rule));
		expect(overlap).toEqual([]);
	});
});
