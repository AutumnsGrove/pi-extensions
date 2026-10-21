import { describe, expect, it } from "vitest";
import { defaultTimeout, hookKey, normalizeHooks, readHooksConfig } from "./config.ts";

describe("readHooksConfig", () => {
	it("reads the hooks key and tolerates junk", () => {
		expect(readHooksConfig({ hooks: { PreToolUse: [] } })).toEqual({ PreToolUse: [] });
		expect(readHooksConfig({})).toBeUndefined();
		expect(readHooksConfig(null)).toBeUndefined();
		expect(readHooksConfig("nope")).toBeUndefined();
	});
});

describe("normalizeHooks", () => {
	it("normalizes a Claude-shaped config", () => {
		const { hooks, warnings } = normalizeHooks({
			PreToolUse: [
				{
					matcher: "bash|write",
					hooks: [
						{ type: "command", command: "check.sh", timeout: 5 },
						{ type: "prompt", prompt: "Is this safe? $ARGUMENTS" },
					],
				},
			],
			SessionStart: [{ hooks: [{ type: "http", url: "https://example.test/hook" }] }],
		});
		expect(warnings).toEqual([]);
		expect(hooks).toHaveLength(3);
		expect(hooks[0]?.event).toBe("PreToolUse");
		expect(hooks[0]?.matcher).toBe("bash|write");
		expect(hooks[2]?.event).toBe("SessionStart");
	});

	it("accepts a command handler without an explicit type", () => {
		const { hooks, warnings } = normalizeHooks({
			PostToolUse: [{ hooks: [{ command: "echo ok" }] }],
		});
		expect(warnings).toEqual([]);
		expect(hooks[0]?.handler.type).toBe("command");
	});

	it("warns about unknown and unsupported events", () => {
		const { hooks, warnings } = normalizeHooks({
			NotAnEvent: [{ hooks: [] }],
			SubagentStart: [{ hooks: [{ type: "command", command: "x" }] }],
		});
		expect(hooks).toEqual([]);
		expect(warnings).toHaveLength(2);
	});

	it("rejects agent handlers with a clear message", () => {
		const { hooks, warnings } = normalizeHooks({
			PreToolUse: [{ hooks: [{ type: "agent", prompt: "review" }] }],
		});
		expect(hooks).toEqual([]);
		expect(warnings[0]).toContain("not implemented");
	});

	it("validates required fields and timeouts", () => {
		const { hooks, warnings } = normalizeHooks({
			PreToolUse: [
				{
					hooks: [
						{ type: "command" },
						{ type: "http" },
						{ type: "prompt" },
						{ type: "command", command: "x", timeout: -1 },
						{ type: "command", command: "x", onFailure: "explode" },
					],
				},
			],
		});
		expect(hooks).toEqual([]);
		expect(warnings).toHaveLength(5);
	});

	it("rejects if on non-tool events", () => {
		const { warnings } = normalizeHooks({
			SessionStart: [{ hooks: [{ type: "http", url: "https://x", if: "Bash(git *)" }] }],
		});
		expect(warnings[0]).toContain("only valid on tool events");
	});
});

describe("hookKey", () => {
	it("is stable regardless of key order", () => {
		const a = hookKey("PreToolUse", "bash", {
			type: "command",
			command: "x",
			timeout: 5,
		});
		const b = hookKey("PreToolUse", "bash", {
			timeout: 5,
			command: "x",
			type: "command",
		});
		expect(a).toBe(b);
	});
});

describe("defaultTimeout", () => {
	it("follows Claude's defaults", () => {
		expect(defaultTimeout("command")).toBe(600);
		expect(defaultTimeout("http")).toBe(600);
		expect(defaultTimeout("prompt")).toBe(30);
		expect(defaultTimeout("agent")).toBe(60);
	});
});
